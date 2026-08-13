import { env } from "cloudflare:workers";
import { collectionSchema } from "./app-manifest";
import {
  countPhysicalRecords,
  createPhysicalBookmark,
  deletePhysicalRecord,
  exportPhysicalDatabaseSql,
  getPhysicalDatabase,
  getPhysicalRecord,
  insertPhysicalRecord,
  listPhysicalRecords,
  restorePhysicalBookmark,
  updatePhysicalRecord,
} from "./database-provisioner";
import { ensureSchema } from "./db";
import { recordServiceEvent } from "./observability";
import { githubAppConfigured } from "./github-app";
import { githubLegacyPatConfigured } from "./github-automation";
import type {
  AppBackup,
  AppManifest,
  AppRecord,
  AppRuntimeActor,
  AppRuntimeSession,
  RunnerJob,
  RuntimeEvidence,
} from "./types";

type D1Row = Record<string, string | number | null>;

export class AppPlatformError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "AppPlatformError";
  }
}

export type VerifiedAppSession = {
  id: string;
  projectId: string;
  actor: AppRuntimeActor;
  expiresAt: string;
};

function database(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new AppPlatformError("应用数据库暂不可用", 503);
  return binding;
}

function archiveBucket(): R2Bucket | null {
  return (env as unknown as { ARCHIVE?: R2Bucket }).ARCHIVE ?? null;
}

export async function getAppManifest(projectId: string): Promise<AppManifest | null> {
  await ensureSchema();
  const row = await database().prepare(`SELECT manifest_json FROM app_manifests WHERE project_id=? AND status='active'`).bind(projectId).first<D1Row>();
  return parseJson<AppManifest | null>(row?.manifest_json, null);
}

export async function resolvePublishedApp(slug: string): Promise<{ projectId: string; versionId: string; manifest: AppManifest } | null> {
  await ensureSchema();
  const project = await database().prepare(`SELECT id,published_version_id,current_version_id FROM projects WHERE slug=?`).bind(slug).first<D1Row>();
  if (!project) return null;
  const versionId = String(project.published_version_id ?? project.current_version_id ?? "");
  if (!versionId) return null;
  const version = await database().prepare(`SELECT manifest_json FROM versions WHERE id=? AND project_id=?`).bind(versionId, String(project.id)).first<D1Row>();
  const manifest = parseJson<AppManifest | null>(version?.manifest_json, null) ?? await getAppManifest(String(project.id));
  return manifest ? { projectId: String(project.id), versionId, manifest } : null;
}

export async function issueAppSession(input: {
  projectId: string;
  actor: AppRuntimeActor;
  refreshToken?: string;
}): Promise<AppRuntimeSession> {
  await ensureSchema();
  const manifest = await getAppManifest(input.projectId);
  if (!manifest) throw new AppPlatformError("应用尚未生成运行时 Manifest", 409);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + manifest.auth.sessionTtlSeconds * 1_000).toISOString();
  const accessToken = randomToken();
  const accessHash = await hashToken(accessToken);
  const d1 = database();

  if (input.refreshToken) {
    const refreshHash = await hashToken(input.refreshToken);
    const existing = await d1.prepare(`SELECT * FROM app_sessions WHERE project_id=? AND refresh_token_hash=? AND expires_at>?`).bind(input.projectId, refreshHash, nowIso).first<D1Row>();
    if (existing) {
      await d1.prepare(`UPDATE app_sessions SET access_token_hash=?,expires_at=?,last_seen_at=? WHERE id=?`).bind(accessHash, expiresAt, nowIso, String(existing.id)).run();
      return {
        projectId: input.projectId,
        token: accessToken,
        expiresAt,
        actor: actorFromSession(existing),
        manifest,
      };
    }
  }

  const refreshToken = randomToken();
  const refreshHash = await hashToken(refreshToken);
  const id = crypto.randomUUID();
  await d1.prepare(`INSERT INTO app_sessions (id,project_id,access_token_hash,refresh_token_hash,subject_id,subject_type,role,display_name,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id,
    input.projectId,
    accessHash,
    refreshHash,
    input.actor.id,
    input.actor.type,
    input.actor.role,
    input.actor.displayName,
    expiresAt,
    nowIso,
    nowIso,
  ).run();
  await d1.prepare(`DELETE FROM app_sessions WHERE expires_at<?`).bind(nowIso).run();
  return { projectId: input.projectId, token: accessToken, refreshToken, expiresAt, actor: input.actor, manifest };
}

export async function verifyAppSession(request: Request, projectId: string): Promise<VerifiedAppSession> {
  await ensureSchema();
  const header = request.headers.get("authorization") ?? "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token || token.length > 240) throw new AppPlatformError("缺少应用运行时会话", 401);
  const tokenHash = await hashToken(token);
  const now = new Date().toISOString();
  const row = await database().prepare(`SELECT * FROM app_sessions WHERE project_id=? AND access_token_hash=? AND expires_at>?`).bind(projectId, tokenHash, now).first<D1Row>();
  if (!row) throw new AppPlatformError("应用运行时会话无效或已过期", 401);
  await database().prepare(`UPDATE app_sessions SET last_seen_at=? WHERE id=?`).bind(now, String(row.id)).run();
  return { id: String(row.id), projectId, actor: actorFromSession(row), expiresAt: String(row.expires_at) };
}

export async function listAppRecords(projectId: string, session: VerifiedAppSession, collectionName: string, limit = 50): Promise<AppRecord[]> {
  const manifest = await requireManifest(projectId);
  const schema = collectionSchema(manifest, collectionName);
  if (!schema) throw new AppPlatformError("这个集合没有在应用 Schema 中声明", 404);
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const privileged = canManage(session.actor.role);
  const physical = await getPhysicalDatabase(projectId);
  if (physical) return listPhysicalRecords(physical, collectionName, session.actor.id, schema.access === "owner" && !privileged, boundedLimit);
  const result = schema.access === "owner" && !privileged
    ? await database().prepare(`SELECT * FROM app_records WHERE project_id=? AND collection=? AND owner_subject=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`).bind(projectId, collectionName, session.actor.id, boundedLimit).all<D1Row>()
    : await database().prepare(`SELECT * FROM app_records WHERE project_id=? AND collection=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`).bind(projectId, collectionName, boundedLimit).all<D1Row>();
  return (result.results ?? []).map(recordFromRow);
}

export async function createAppRecord(projectId: string, session: VerifiedAppSession, collectionName: string, input: unknown): Promise<AppRecord> {
  assertWritable(session);
  const manifest = await requireManifest(projectId);
  const schema = collectionSchema(manifest, collectionName);
  if (!schema) throw new AppPlatformError("这个集合没有在应用 Schema 中声明", 404);
  const data = validateRecordData(schema, input, null);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const physical = await getPhysicalDatabase(projectId);
  if (physical) {
    const record = await insertPhysicalRecord(physical, collectionName, session.actor.id, data);
    await recordUsage(projectId, null, "database_write", 1, "records");
    return record;
  }
  await database().prepare(`INSERT INTO app_records (id,project_id,collection,owner_subject,data_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)`).bind(id, projectId, collectionName, session.actor.id, JSON.stringify(data), now, now).run();
  await recordUsage(projectId, null, "database_write", 1, "records");
  return { id, projectId, collection: collectionName, ownerSubject: session.actor.id, data, revision: 1, createdAt: now, updatedAt: now };
}

export async function updateAppRecord(projectId: string, session: VerifiedAppSession, collectionName: string, recordId: string, input: unknown): Promise<AppRecord> {
  assertWritable(session);
  const manifest = await requireManifest(projectId);
  const schema = collectionSchema(manifest, collectionName);
  if (!schema) throw new AppPlatformError("这个集合没有在应用 Schema 中声明", 404);
  const physical = await getPhysicalDatabase(projectId);
  const physicalCurrent = physical ? await getPhysicalRecord(physical, collectionName, recordId) : null;
  const current = physical ? physicalCurrent : await database().prepare(`SELECT * FROM app_records WHERE id=? AND project_id=? AND collection=? AND deleted_at IS NULL`).bind(recordId, projectId, collectionName).first<D1Row>();
  if (!current) throw new AppPlatformError("记录不存在", 404);
  const ownerSubject = physicalCurrent ? physicalCurrent.ownerSubject : String((current as D1Row).owner_subject);
  if (!canManage(session.actor.role) && ownerSubject !== session.actor.id) throw new AppPlatformError("不能修改其他用户的数据", 403);
  const raw = objectValue(input);
  const currentRevision = physicalCurrent ? physicalCurrent.revision : Number((current as D1Row).revision);
  const expectedRevision = typeof raw._revision === "number" ? Math.floor(raw._revision) : currentRevision;
  if (expectedRevision !== currentRevision) throw new AppPlatformError("数据已经被其他操作更新，请刷新后重试", 409);
  const patch = { ...raw };
  delete patch._revision;
  const currentData = physicalCurrent ? physicalCurrent.data : parseJson<Record<string, unknown>>((current as D1Row).data_json, {});
  const data = validateRecordData(schema, patch, currentData);
  if (physical) {
    const updated = await updatePhysicalRecord(physical, collectionName, recordId, expectedRevision, data);
    if (!updated) throw new AppPlatformError("数据并发更新冲突，请刷新后重试", 409);
    await recordUsage(projectId, null, "database_write", 1, "records");
    return updated;
  }
  const now = new Date().toISOString();
  const updated = await database().prepare(`UPDATE app_records SET data_json=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=? RETURNING *`).bind(JSON.stringify(data), now, recordId, projectId, expectedRevision).first<D1Row>();
  if (!updated) throw new AppPlatformError("数据并发更新冲突，请刷新后重试", 409);
  await recordUsage(projectId, null, "database_write", 1, "records");
  return recordFromRow(updated);
}

export async function deleteAppRecord(projectId: string, session: VerifiedAppSession, collectionName: string, recordId: string): Promise<void> {
  assertWritable(session);
  const physical = await getPhysicalDatabase(projectId);
  if (physical) {
    const current = await getPhysicalRecord(physical, collectionName, recordId);
    if (!current) throw new AppPlatformError("记录不存在", 404);
    if (!canManage(session.actor.role) && current.ownerSubject !== session.actor.id) throw new AppPlatformError("不能删除其他用户的数据", 403);
    if (!await deletePhysicalRecord(physical, collectionName, recordId, canManage(session.actor.role) ? null : session.actor.id)) throw new AppPlatformError("记录不存在或已经删除", 404);
    await recordUsage(projectId, null, "database_write", 1, "records");
    return;
  }
  const current = await database().prepare(`SELECT owner_subject FROM app_records WHERE id=? AND project_id=? AND collection=? AND deleted_at IS NULL`).bind(recordId, projectId, collectionName).first<D1Row>();
  if (!current) throw new AppPlatformError("记录不存在", 404);
  if (!canManage(session.actor.role) && String(current.owner_subject) !== session.actor.id) throw new AppPlatformError("不能删除其他用户的数据", 403);
  await database().prepare(`UPDATE app_records SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=? AND project_id=?`).bind(new Date().toISOString(), new Date().toISOString(), recordId, projectId).run();
  await recordUsage(projectId, null, "database_write", 1, "records");
}

export async function recordRuntimeEvidence(input: {
  projectId: string;
  versionId?: string | null;
  sessionId?: string | null;
  source: RuntimeEvidence["source"];
  level: RuntimeEvidence["level"];
  message: string;
  evidence?: Record<string, unknown>;
}): Promise<RuntimeEvidence> {
  await ensureSchema();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const evidence = boundedJsonObject(input.evidence ?? {}, input.source === "browser-runner" ? 140_000 : 48_000);
  const message = input.message.trim().slice(0, 2_000) || "运行时事件";
  await database().prepare(`INSERT INTO runtime_evidence (id,project_id,version_id,session_id,source,level,message,evidence_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(id, input.projectId, input.versionId ?? null, input.sessionId ?? null, input.source, input.level, message, JSON.stringify(evidence), now).run();
  await database().prepare(`DELETE FROM runtime_evidence WHERE project_id=? AND id NOT IN (SELECT id FROM runtime_evidence WHERE project_id=? ORDER BY created_at DESC LIMIT 500)`).bind(input.projectId, input.projectId).run();
  await recordServiceEvent({ projectId: input.projectId, service: "generated-runtime", operation: input.source, level: input.level, message, detail: evidence }).catch(() => undefined);
  return { id, projectId: input.projectId, versionId: input.versionId ?? null, source: input.source, level: input.level, message, evidence, createdAt: now };
}

export async function listRuntimeEvidence(projectId: string, limit = 50): Promise<RuntimeEvidence[]> {
  await ensureSchema();
  const result = await database().prepare(`SELECT * FROM runtime_evidence WHERE project_id=? ORDER BY created_at DESC LIMIT ?`).bind(projectId, Math.max(1, Math.min(200, limit))).all<D1Row>();
  return (result.results ?? []).map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    versionId: row.version_id ? String(row.version_id) : null,
    source: String(row.source) as RuntimeEvidence["source"],
    level: String(row.level) as RuntimeEvidence["level"],
    message: String(row.message),
    evidence: parseJson<Record<string, unknown>>(row.evidence_json, {}),
    createdAt: String(row.created_at),
  }));
}

export async function claimBrowserRunnerRepair(projectId: string): Promise<RuntimeEvidence | null> {
  await ensureSchema();
  const row = await database().prepare(`SELECT * FROM runtime_evidence WHERE project_id=? AND source='browser-runner' AND level='error' AND processed_at IS NULL ORDER BY created_at ASC LIMIT 1`).bind(projectId).first<D1Row>();
  if (!row) return null;
  const processedAt = new Date().toISOString();
  const claimed = await database().prepare(`UPDATE runtime_evidence SET processed_at=? WHERE id=? AND processed_at IS NULL RETURNING *`).bind(processedAt, String(row.id)).first<D1Row>();
  if (!claimed) return null;
  return {
    id: String(claimed.id),
    projectId: String(claimed.project_id),
    versionId: claimed.version_id ? String(claimed.version_id) : null,
    source: "browser-runner",
    level: "error",
    message: String(claimed.message),
    evidence: parseJson<Record<string, unknown>>(claimed.evidence_json, {}),
    createdAt: String(claimed.created_at),
  };
}

export async function createAppBackup(projectId: string, actorId: string, label = "手动备份"): Promise<AppBackup> {
  await ensureSchema();
  const physical = await getPhysicalDatabase(projectId);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const safeLabel = label.trim().slice(0, 120) || "手动备份";
  const archiveStatus = archiveBucket() ? "pending" : "not-configured";
  if (physical) {
    const bookmark = await createPhysicalBookmark(physical);
    const recordCount = await countPhysicalRecords(physical);
    const snapshot = JSON.stringify({ provider: "cloudflare-d1-time-travel", externalDatabaseId: physical.externalDatabaseId, bookmark });
    await database().prepare(`INSERT INTO app_backups (id,project_id,label,snapshot_json,record_count,created_by,archive_status,expires_at,created_at) VALUES (?,?,?,?,?,?,?, ?,?)`).bind(id, projectId, safeLabel, snapshot, recordCount, actorId, archiveStatus, expiresAt, now).run();
    if (archiveStatus === "pending") await archivePhysicalBackup(id, physical).catch((error) => markArchiveFailure(id, error));
    await recordServiceEvent({ projectId, service: "database", operation: "backup.time-travel", level: "info", message: "Cloudflare D1 Time Travel 书签已创建", detail: { recordCount, backupId: id } }).catch(() => undefined);
    return await readAppBackup(projectId, id);
  }
  const result = await database().prepare(`SELECT * FROM app_records WHERE project_id=? AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 5000`).bind(projectId).all<D1Row>();
  const records = (result.results ?? []).map(recordFromRow);
  const snapshot = JSON.stringify(records);
  if (snapshot.length > 1_800_000) throw new AppPlatformError("应用数据超过单次 D1 备份上限，请配置外部对象存储", 413);
  await database().prepare(`INSERT INTO app_backups (id,project_id,label,snapshot_json,record_count,created_by,archive_status,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(id, projectId, safeLabel, snapshot, records.length, actorId, archiveStatus, expiresAt, now).run();
  if (archiveStatus === "pending") await archiveLogicalBackup(id, projectId, snapshot).catch((error) => markArchiveFailure(id, error));
  await recordServiceEvent({ projectId, service: "database", operation: "backup.snapshot", level: "info", message: "逻辑 D1 快照已创建", detail: { recordCount: records.length, backupId: id } }).catch(() => undefined);
  return await readAppBackup(projectId, id);
}

export async function listAppBackups(projectId: string): Promise<AppBackup[]> {
  await ensureSchema();
  const result = await database().prepare(`SELECT * FROM app_backups WHERE project_id=? ORDER BY created_at DESC LIMIT 30`).bind(projectId).all<D1Row>();
  return (result.results ?? []).map(appBackupFromRow);
}

export async function restoreAppBackup(projectId: string, backupId: string, actorId: string): Promise<AppBackup> {
  await ensureSchema();
  const backup = await database().prepare(`SELECT * FROM app_backups WHERE id=? AND project_id=?`).bind(backupId, projectId).first<D1Row>();
  if (!backup) throw new AppPlatformError("备份不存在", 404);
  const physicalSnapshot = parseJson<{ provider?: string; bookmark?: string }>(backup.snapshot_json, {});
  if (physicalSnapshot.provider === "cloudflare-d1-time-travel") {
    const physical = await getPhysicalDatabase(projectId);
    if (!physical || !physicalSnapshot.bookmark) throw new AppPlatformError("物理数据库或 Time Travel 书签不可用", 409);
    await createAppBackup(projectId, actorId, `恢复前自动备份 ${new Date().toLocaleString("zh-CN")}`);
    await restorePhysicalBookmark(physical, physicalSnapshot.bookmark);
    return createAppBackup(projectId, actorId, `已恢复：${String(backup.label)}`);
  }
  await createAppBackup(projectId, actorId, `恢复前自动备份 ${new Date().toLocaleString("zh-CN")}`);
  const records = parseJson<AppRecord[]>(backup.snapshot_json, []);
  const d1 = database();
  await d1.prepare(`DELETE FROM app_records WHERE project_id=?`).bind(projectId).run();
  const statements = [];
  for (const record of records.slice(0, 5_000)) {
    statements.push(d1.prepare(`INSERT INTO app_records (id,project_id,collection,owner_subject,data_json,revision,deleted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,?)`).bind(record.id, projectId, record.collection, record.ownerSubject, JSON.stringify(record.data), record.revision, record.createdAt, record.updatedAt));
    if (statements.length === 80) await d1.batch(statements.splice(0, statements.length));
  }
  if (statements.length > 0) await d1.batch(statements);
  return createAppBackup(projectId, actorId, `已恢复：${String(backup.label)}`);
}

async function archivePhysicalBackup(backupId: string, resource: NonNullable<Awaited<ReturnType<typeof getPhysicalDatabase>>>): Promise<void> {
  const bucket = archiveBucket();
  if (!bucket) return;
  const exported = await exportPhysicalDatabaseSql(resource);
  const key = `database-backups/${safeArchiveSegment(resource.projectId)}/${backupId}.sql`;
  const object = await bucket.put(key, exported.response.body!, {
    httpMetadata: { contentType: "application/sql" },
    customMetadata: { projectId: resource.projectId, databaseId: resource.externalDatabaseId ?? "", bookmark: exported.bookmark, sourceFilename: exported.filename.slice(0, 512) },
  });
  await database().prepare(`UPDATE app_backups SET archive_key=?,archive_status='ready',archive_bytes=?,archive_error=NULL WHERE id=?`).bind(key, object.size, backupId).run();
}

async function archiveLogicalBackup(backupId: string, projectId: string, snapshot: string): Promise<void> {
  const bucket = archiveBucket();
  if (!bucket) return;
  const key = `database-backups/${safeArchiveSegment(projectId)}/${backupId}.json`;
  const object = await bucket.put(key, snapshot, { httpMetadata: { contentType: "application/json" }, customMetadata: { projectId, kind: "logical-d1-snapshot" } });
  await database().prepare(`UPDATE app_backups SET archive_key=?,archive_status='ready',archive_bytes=?,archive_error=NULL WHERE id=?`).bind(key, object.size, backupId).run();
}

async function markArchiveFailure(backupId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : "对象存储归档失败";
  const row = await database().prepare(`UPDATE app_backups SET archive_status='failed',archive_error=? WHERE id=? RETURNING project_id`).bind(message.slice(0, 800), backupId).first<D1Row>();
  await recordServiceEvent({ projectId: row?.project_id ? String(row.project_id) : null, service: "database", operation: "backup.archive", level: "error", message, detail: { backupId } }).catch(() => undefined);
}

async function readAppBackup(projectId: string, backupId: string): Promise<AppBackup> {
  const row = await database().prepare(`SELECT * FROM app_backups WHERE id=? AND project_id=?`).bind(backupId, projectId).first<D1Row>();
  if (!row) throw new AppPlatformError("备份写入后无法读取", 500);
  return appBackupFromRow(row);
}

async function deleteExpiredAppBackups(projectId: string, before: string): Promise<{ deleted: number; failed: number }> {
  const rows = await database().prepare(`SELECT id,archive_key FROM app_backups WHERE project_id=? AND created_at<? AND created_by='system:scheduled-backup' ORDER BY created_at ASC LIMIT 100`).bind(projectId, before).all<D1Row>();
  let deleted = 0;
  let failed = 0;
  for (const row of rows.results ?? []) {
    try {
      if (row.archive_key) {
        const bucket = archiveBucket();
        if (!bucket) throw new AppPlatformError("归档桶未绑定，暂缓删除以避免遗留对象", 503);
        await bucket.delete(String(row.archive_key));
      }
      const result = await database().prepare(`DELETE FROM app_backups WHERE id=? AND project_id=?`).bind(row.id, projectId).run();
      deleted += Number(result.meta.changes ?? 0);
    } catch (error) {
      failed += 1;
      await database().prepare(`UPDATE app_backups SET archive_error=? WHERE id=?`).bind((error instanceof Error ? error.message : "过期备份清理失败").slice(0, 800), row.id).run();
    }
  }
  return { deleted, failed };
}

export async function runDueAppBackups(limit = 20): Promise<{ completed: string[]; failed: Array<{ projectId: string; error: string }> }> {
  await ensureSchema();
  const due = await database().prepare(`SELECT p.* FROM backup_policies p JOIN projects project ON project.id=p.project_id WHERE p.enabled=1 AND (p.next_run_at IS NULL OR p.next_run_at<=?) ORDER BY COALESCE(p.next_run_at,p.created_at) ASC LIMIT ?`).bind(new Date().toISOString(), Math.max(1, Math.min(100, limit))).all<D1Row>();
  const completed: string[] = [];
  const failed: Array<{ projectId: string; error: string }> = [];
  for (const row of due.results ?? []) {
    const projectId = String(row.project_id);
    const intervalHours = Math.max(1, Math.min(168, Number(row.interval_hours ?? 24)));
    try {
      await createAppBackup(projectId, "system:scheduled-backup", `定时备份 ${new Date().toLocaleString("zh-CN")}`);
      const now = new Date();
      await database().prepare(`UPDATE backup_policies SET last_run_at=?,next_run_at=?,updated_at=? WHERE project_id=?`).bind(now.toISOString(), new Date(now.getTime() + intervalHours * 3_600_000).toISOString(), now.toISOString(), projectId).run();
      const retentionDays = Math.max(1, Math.min(365, Number(row.retention_days ?? 30)));
      await deleteExpiredAppBackups(projectId, new Date(Date.now() - retentionDays * 86_400_000).toISOString());
      completed.push(projectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "定时备份失败";
      await database().prepare(`UPDATE backup_policies SET next_run_at=?,updated_at=? WHERE project_id=?`).bind(new Date(Date.now() + 60 * 60_000).toISOString(), new Date().toISOString(), projectId).run();
      await recordServiceEvent({ projectId, service: "database", operation: "backup.scheduled", level: "error", message, detail: { retryInMinutes: 60 } }).catch(() => undefined);
      failed.push({ projectId, error: message });
    }
  }
  return { completed, failed };
}

export async function createRunnerJob(input: { projectId: string; versionId: string | null; kind: RunnerJob["kind"]; request: Record<string, unknown>; provider?: string }): Promise<RunnerJob> {
  await ensureSchema();
  const runtime = env as unknown as Record<string, unknown>;
  const githubRunnerReady = Boolean((runtime.GITHUB_RUNNER_INSTALLATION_ID && githubAppConfigured()) || githubLegacyPatConfigured());
  const configured = input.kind === "playwright"
    ? Boolean(githubRunnerReady && runtime.NUCLEUS_RUNNER_CALLBACK_TOKEN && runtime.GITHUB_RUNNER_REPOSITORY)
    : input.kind === "container-build"
      ? Boolean(runtime.NUCLEUS_CONTAINER_RUNNER_URL && runtime.NUCLEUS_CONTAINER_RUNNER_TOKEN && runtime.NUCLEUS_RUNNER_CALLBACK_TOKEN)
      : githubRunnerReady;
  const status: RunnerJob["status"] = configured ? "queued" : "configuration-required";
  const now = new Date().toISOString();
  const job: RunnerJob = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    versionId: input.versionId,
    kind: input.kind,
    status,
    provider: input.provider ?? (input.kind === "container-build" ? "external-container-runner" : "github-actions"),
    request: boundedJsonObject(input.request, 32_000),
    result: configured ? null : { message: "外部 Runner 协议已就绪；部署环境尚未配置服务端凭据" },
    createdAt: now,
    startedAt: null,
    completedAt: configured ? null : now,
  };
  await database().prepare(`INSERT INTO runner_jobs (id,project_id,version_id,kind,status,provider,request_json,result_json,attempts,created_at,started_at,completed_at) VALUES (?,?,?,?,?,?,?,?,0,?,?,?)`).bind(job.id, job.projectId, job.versionId, job.kind, job.status, job.provider, JSON.stringify(job.request), job.result ? JSON.stringify(job.result) : null, job.createdAt, job.startedAt, job.completedAt).run();
  return job;
}

export async function listRunnerJobs(projectId: string): Promise<RunnerJob[]> {
  await ensureSchema();
  const result = await database().prepare(`SELECT * FROM runner_jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 50`).bind(projectId).all<D1Row>();
  return (result.results ?? []).map(runnerJobFromRow);
}

export async function completeRunnerJob(jobId: string, status: "passed" | "failed", result: Record<string, unknown>): Promise<RunnerJob | null> {
  await ensureSchema();
  const now = new Date().toISOString();
  const row = await database().prepare(`UPDATE runner_jobs SET status=?,result_json=?,completed_at=?,started_at=COALESCE(started_at,?) WHERE id=? AND status IN ('queued','running') RETURNING *`).bind(status, JSON.stringify(boundedJsonObject(result, 120_000)), now, now, jobId).first<D1Row>();
  if (row) await recordServiceEvent({ projectId: String(row.project_id), service: "runner", operation: String(row.kind), level: status === "failed" ? "error" : "info", message: status === "failed" ? "外部 Runner 验收失败" : "外部 Runner 验收通过", detail: boundedJsonObject(result, 32_000) }).catch(() => undefined);
  return row ? runnerJobFromRow(row) : null;
}

export async function markRunnerJobRunning(jobId: string): Promise<RunnerJob | null> {
  await ensureSchema();
  const now = new Date().toISOString();
  const row = await database().prepare(`UPDATE runner_jobs SET status='running',attempts=attempts+1,started_at=?,completed_at=NULL WHERE id=? AND status='queued' RETURNING *`).bind(now, jobId).first<D1Row>();
  return row ? runnerJobFromRow(row) : null;
}

export async function runtimePlatformStats(projectId: string): Promise<{ records: number; sessions: number; errors: number; backups: number; runnerJobs: number; usageTokens: number }> {
  await ensureSchema();
  const physical = await getPhysicalDatabase(projectId);
  const [records, sessions, errors, backups, jobs, tokens] = await database().batch([
    database().prepare(`SELECT COUNT(*) AS count FROM app_records WHERE project_id=? AND deleted_at IS NULL`).bind(projectId),
    database().prepare(`SELECT COUNT(*) AS count FROM app_sessions WHERE project_id=? AND expires_at>?`).bind(projectId, new Date().toISOString()),
    database().prepare(`SELECT COUNT(*) AS count FROM runtime_evidence WHERE project_id=? AND level='error'`).bind(projectId),
    database().prepare(`SELECT COUNT(*) AS count FROM app_backups WHERE project_id=?`).bind(projectId),
    database().prepare(`SELECT COUNT(*) AS count FROM runner_jobs WHERE project_id=?`).bind(projectId),
    database().prepare(`SELECT COALESCE(SUM(quantity),0) AS count FROM usage_events WHERE project_id=? AND kind='model_tokens'`).bind(projectId),
  ]);
  const count = (result: D1Result<unknown>) => Number((result.results?.[0] as { count?: number } | undefined)?.count ?? 0);
  return { records: physical ? await countPhysicalRecords(physical) : count(records), sessions: count(sessions), errors: count(errors), backups: count(backups), runnerJobs: count(jobs), usageTokens: count(tokens) };
}

async function requireManifest(projectId: string): Promise<AppManifest> {
  const manifest = await getAppManifest(projectId);
  if (!manifest) throw new AppPlatformError("应用运行时 Manifest 不存在", 409);
  return manifest;
}

function validateRecordData(schema: AppManifest["database"]["collections"][number], input: unknown, current: Record<string, unknown> | null): Record<string, unknown> {
  const raw = objectValue(input);
  const allowed = new Set(schema.fields.map((field) => field.name));
  for (const key of Object.keys(raw)) {
    if (key === "_revision") continue;
    if (!allowed.has(key)) throw new AppPlatformError(`字段 ${key} 没有在 Schema 中声明`);
  }
  const output: Record<string, unknown> = current ? { ...current } : {};
  for (const field of schema.fields) {
    let value = Object.prototype.hasOwnProperty.call(raw, field.name) ? raw[field.name] : output[field.name];
    if (value === undefined && field.default !== undefined) value = field.default;
    if ((value === undefined || value === null || value === "") && field.required) throw new AppPlatformError(`字段 ${field.name} 必填`);
    if (value === undefined) continue;
    if (value === null && !field.required) { output[field.name] = null; continue; }
    if (field.type === "string") {
      if (typeof value !== "string") throw new AppPlatformError(`字段 ${field.name} 必须是字符串`);
      if (value.length > (field.maxLength ?? 2_000)) throw new AppPlatformError(`字段 ${field.name} 超过长度上限`);
    } else if (field.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new AppPlatformError(`字段 ${field.name} 必须是有限数字`);
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") throw new AppPlatformError(`字段 ${field.name} 必须是布尔值`);
    } else if (field.type === "date") {
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new AppPlatformError(`字段 ${field.name} 必须是 ISO 日期字符串`);
    } else if (JSON.stringify(value).length > 16_000) {
      throw new AppPlatformError(`字段 ${field.name} 的 JSON 数据过大`);
    }
    output[field.name] = value;
  }
  const serialized = JSON.stringify(output);
  if (serialized.length > 32_000) throw new AppPlatformError("单条记录不能超过 32KB", 413);
  return output;
}

async function recordUsage(projectId: string, runId: string | null, kind: string, quantity: number, unit: string, model: string | null = null): Promise<void> {
  await database().prepare(`INSERT INTO usage_events (id,organization_id,project_id,run_id,kind,quantity,unit,model,created_at) SELECT ?,organization_id,?,?,?,?,?,?,? FROM projects WHERE id=?`).bind(crypto.randomUUID(), projectId, runId, kind, quantity, unit, model, new Date().toISOString(), projectId).run();
}

function assertWritable(session: VerifiedAppSession): void {
  if (session.actor.role === "viewer" || session.actor.role === "reviewer") throw new AppPlatformError("当前角色只有只读权限", 403);
}

function canManage(role: AppRuntimeActor["role"]): boolean {
  return role === "owner" || role === "editor" || role === "reviewer" || role === "viewer";
}

function actorFromSession(row: D1Row): AppRuntimeActor {
  return {
    id: String(row.subject_id),
    type: String(row.subject_type) as AppRuntimeActor["type"],
    role: String(row.role) as AppRuntimeActor["role"],
    displayName: row.display_name ? String(row.display_name) : null,
  };
}

function recordFromRow(row: D1Row): AppRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    collection: String(row.collection),
    ownerSubject: String(row.owner_subject),
    data: parseJson<Record<string, unknown>>(row.data_json, {}),
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function appBackupFromRow(row: D1Row): AppBackup {
  const snapshot = parseJson<{ provider?: string; bookmark?: string }>(row.snapshot_json, {});
  const physical = snapshot.provider === "cloudflare-d1-time-travel";
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    label: String(row.label),
    recordCount: Number(row.record_count),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    provider: physical ? "cloudflare-d1-time-travel" : "snapshot",
    status: "ready",
    bookmark: physical ? snapshot.bookmark ?? null : null,
    archiveKey: row.archive_key ? String(row.archive_key) : null,
    archiveStatus: row.archive_status ? String(row.archive_status) as AppBackup["archiveStatus"] : "not-configured",
    archiveBytes: row.archive_bytes === null || row.archive_bytes === undefined ? null : Number(row.archive_bytes),
    archiveError: row.archive_error ? String(row.archive_error) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
  };
}

function runnerJobFromRow(row: D1Row): RunnerJob {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    versionId: row.version_id ? String(row.version_id) : null,
    kind: String(row.kind) as RunnerJob["kind"],
    status: String(row.status) as RunnerJob["status"],
    provider: String(row.provider),
    request: parseJson<Record<string, unknown>>(row.request_json, {}),
    result: parseJson<Record<string, unknown> | null>(row.result_json, null),
    createdAt: String(row.created_at),
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

function boundedJsonObject(value: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxChars) return value;
    return { truncated: true, preview: serialized.slice(0, maxChars) };
  } catch {
    return { serializationError: true };
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function randomToken(): string {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

function safeArchiveSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "unknown-project";
}

async function hashToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
