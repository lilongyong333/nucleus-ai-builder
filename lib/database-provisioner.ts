import { env } from "cloudflare:workers";
import { ensureSchema } from "./db";
import { databaseSchemaRevision, provisioningRetryDelayMs } from "./database-schema";
import type { AppDatabaseResource, AppManifest, AppRecord, ProvisioningEvent } from "./types";

type D1Row = Record<string, string | number | null>;
type CloudflareEnvelope<T> = { success?: boolean; result?: T; errors?: Array<{ code?: number; message?: string }>; messages?: Array<{ message?: string }> };
type CloudflareDatabase = { uuid: string; name: string; primary_location_hint?: string };
type RemoteQueryResult = { results?: D1Row[]; meta?: Record<string, unknown>; success?: boolean; error?: string };
type DatabaseExportResult = {
  at_bookmark?: string;
  error?: string;
  status?: "complete" | "error";
  success?: boolean;
  result?: { filename?: string; signed_url?: string };
};

export class DatabaseProvisioningError extends Error {
  constructor(message: string, readonly status = 400, readonly retryable = false) {
    super(message);
    this.name = "DatabaseProvisioningError";
  }
}

function controlDatabase(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new DatabaseProvisioningError("控制面数据库暂不可用", 503, true);
  return binding;
}

function configuration(): { accountId: string; token: string; locationHint: string | null } | null {
  const runtime = env as unknown as Record<string, unknown>;
  const accountId = stringEnv(runtime.CLOUDFLARE_ACCOUNT_ID);
  const token = stringEnv(runtime.CLOUDFLARE_D1_API_TOKEN);
  if (!accountId || !token) return null;
  return { accountId, token, locationHint: stringEnv(runtime.NUCLEUS_D1_LOCATION_HINT) };
}

export function databaseProvisionerConfigured(): boolean {
  return configuration() !== null;
}

export async function getDatabaseResource(projectId: string): Promise<AppDatabaseResource | null> {
  await ensureSchema();
  const row = await controlDatabase().prepare(`SELECT * FROM app_database_resources WHERE project_id=?`).bind(projectId).first<D1Row>();
  return row ? resourceFromRow(row) : null;
}

export async function listProvisioningEvents(projectId: string, limit = 30): Promise<ProvisioningEvent[]> {
  await ensureSchema();
  const result = await controlDatabase().prepare(`SELECT * FROM provisioning_events WHERE project_id=? ORDER BY started_at DESC LIMIT ?`).bind(projectId, Math.max(1, Math.min(100, limit))).all<D1Row>();
  return (result.results ?? []).map(eventFromRow);
}

export async function ensureProjectDatabase(projectId: string): Promise<AppDatabaseResource> {
  await ensureSchema();
  const manifest = await readManifest(projectId);
  if (!manifest) throw new DatabaseProvisioningError("应用尚未生成运行时 Schema", 409);
  const d1 = controlDatabase();
  const now = new Date().toISOString();
  const databaseName = physicalDatabaseName(projectId);
  const desiredSchemaVersion = await databaseSchemaRevision(manifest);
  await d1.prepare(`INSERT INTO app_database_resources (project_id,provider,isolation,status,external_database_id,database_name,location_hint,schema_version,desired_schema_version,attempt_count,next_retry_at,lease_expires_at,last_migration_at,last_backup_at,retention_until,last_error,created_at,updated_at) VALUES (?,'cloudflare-d1','physical-database','pending',NULL,?,NULL,0,?,0,NULL,NULL,NULL,NULL,NULL,NULL,?,?) ON CONFLICT(project_id) DO UPDATE SET desired_schema_version=excluded.desired_schema_version,database_name=excluded.database_name,updated_at=CASE WHEN app_database_resources.desired_schema_version<>excluded.desired_schema_version THEN excluded.updated_at ELSE app_database_resources.updated_at END`).bind(projectId, databaseName, desiredSchemaVersion, now, now).run();

  const config = configuration();
  if (!config) {
    await d1.prepare(`UPDATE app_database_resources SET status='configuration-required',last_error='缺少 CLOUDFLARE_ACCOUNT_ID 或 CLOUDFLARE_D1_API_TOKEN',next_retry_at=NULL,lease_expires_at=NULL,updated_at=? WHERE project_id=? AND status NOT IN ('ready','deletion-scheduled','deleted')`).bind(now, projectId).run();
    await recordProvisioningEvent(projectId, "create", "configuration-required", { missing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_API_TOKEN"] }, now);
    await updateManifestDatabaseState(projectId, "configuration-required");
    return (await getDatabaseResource(projectId))!;
  }

  let current = await getDatabaseResource(projectId);
  if (!current) throw new DatabaseProvisioningError("数据库资源初始化失败", 500, true);
  if (current.status === "deletion-scheduled" || current.status === "deleted") throw new DatabaseProvisioningError("数据库处于删除生命周期，必须先取消删除计划", 409);
  if (current.status === "ready" && current.externalDatabaseId && current.schemaVersion === desiredSchemaVersion) {
    await updateManifestDatabaseState(projectId, "ready");
    return current;
  }
  if (current.status === "provisioning" && current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) > Date.now()) return current;
  if (current.status === "provisioning") {
    await d1.prepare(`UPDATE app_database_resources SET status='error',last_error='上一次 Provisioner 租约超时，已自动回收',lease_expires_at=NULL,next_retry_at=?,updated_at=? WHERE project_id=? AND status='provisioning'`).bind(now, now, projectId).run();
    current = (await getDatabaseResource(projectId))!;
  }
  const leaseExpiresAt = new Date(Date.now() + 4 * 60_000).toISOString();
  const lock = await d1.prepare(`UPDATE app_database_resources SET status='provisioning',location_hint=?,desired_schema_version=?,attempt_count=attempt_count+1,next_retry_at=NULL,lease_expires_at=?,last_error=NULL,retention_until=NULL,updated_at=? WHERE project_id=? AND status IN ('pending','error','configuration-required','ready')`).bind(config.locationHint, desiredSchemaVersion, leaseExpiresAt, now, projectId).run();
  if (Number(lock.meta.changes ?? 0) !== 1) return (await getDatabaseResource(projectId))!;

  const eventId = await startProvisioningEvent(projectId, current?.externalDatabaseId ? "migrate" : "create", { databaseName });
  try {
    let externalId = current?.externalDatabaseId;
    if (!externalId) {
      const created = await cloudflareRequest<CloudflareDatabase>(config, `/d1/database`, {
        method: "POST",
        body: {
          name: databaseName,
          ...(config.locationHint ? { primary_location_hint: config.locationHint } : {}),
        },
      });
      externalId = created.uuid;
      await d1.prepare(`UPDATE app_database_resources SET external_database_id=?,database_name=?,location_hint=COALESCE(?,location_hint),updated_at=? WHERE project_id=?`).bind(externalId, created.name || databaseName, created.primary_location_hint ?? config.locationHint, new Date().toISOString(), projectId).run();
    }

    const schemaVersion = await migratePhysicalDatabase(config, externalId, manifest);
    const migratedRecords = await migrateLogicalRecords(config, externalId, manifest, projectId);
    const completedAt = new Date().toISOString();
    await d1.prepare(`UPDATE app_database_resources SET status='ready',schema_version=?,desired_schema_version=?,attempt_count=0,next_retry_at=NULL,lease_expires_at=NULL,last_migration_at=?,last_error=NULL,updated_at=? WHERE project_id=?`).bind(schemaVersion, schemaVersion, completedAt, completedAt, projectId).run();
    const replayedRecords = await migrateLogicalRecords(config, externalId, manifest, projectId);
    await d1.batch([
      d1.prepare(`INSERT INTO backup_policies (project_id,enabled,interval_hours,retention_days,last_run_at,next_run_at,created_at,updated_at) VALUES (?,1,24,30,NULL,?,?,?) ON CONFLICT(project_id) DO NOTHING`).bind(projectId, new Date(Date.now() + 86_400_000).toISOString(), completedAt, completedAt),
      d1.prepare(`UPDATE provisioning_events SET status='completed',detail_json=?,completed_at=? WHERE id=?`).bind(JSON.stringify({ databaseName, externalDatabaseId: externalId, schemaVersion, migratedRecords, replayedRecords, collections: manifest.database.collections.map((item) => item.name) }), completedAt, eventId),
    ]);
    await updateManifestDatabaseState(projectId, "ready");
    return (await getDatabaseResource(projectId))!;
  } catch (error) {
    const message = error instanceof Error ? error.message : "物理数据库创建失败";
    const failedAt = new Date().toISOString();
    const failedResource = await getDatabaseResource(projectId);
    const nextRetryAt = new Date(Date.now() + provisioningRetryDelayMs(failedResource?.attemptCount ?? 1)).toISOString();
    await d1.batch([
      d1.prepare(`UPDATE app_database_resources SET status='error',last_error=?,next_retry_at=?,lease_expires_at=NULL,updated_at=? WHERE project_id=?`).bind(message.slice(0, 800), nextRetryAt, failedAt, projectId),
      d1.prepare(`UPDATE provisioning_events SET status='failed',detail_json=?,completed_at=? WHERE id=?`).bind(JSON.stringify({ databaseName, error: message.slice(0, 800), nextRetryAt }), failedAt, eventId),
    ]);
    await updateManifestDatabaseState(projectId, "error");
    throw error instanceof DatabaseProvisioningError ? error : new DatabaseProvisioningError(message, 502, true);
  }
}

export async function reconcileProjectDatabases(limit = 5): Promise<{ configured: boolean; attempted: number; ready: string[]; failed: Array<{ projectId: string; error: string }>; skipped: string[] }> {
  await ensureSchema();
  const boundedLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  await controlDatabase().prepare(`UPDATE app_database_resources SET status='error',last_error='Provisioner 租约过期，等待自动重试',lease_expires_at=NULL,next_retry_at=?,updated_at=? WHERE status='provisioning' AND ((lease_expires_at IS NOT NULL AND lease_expires_at<=?) OR (lease_expires_at IS NULL AND updated_at<=?))`).bind(now, now, now, staleBefore).run();
  if (!configuration()) {
    await controlDatabase().prepare(`UPDATE app_database_resources SET status='configuration-required',last_error='缺少 CLOUDFLARE_ACCOUNT_ID 或 CLOUDFLARE_D1_API_TOKEN',next_retry_at=NULL,lease_expires_at=NULL,updated_at=? WHERE status IN ('pending','error')`).bind(now).run();
    return { configured: false, attempted: 0, ready: [], failed: [], skipped: [] };
  }
  const candidates = await controlDatabase().prepare(`SELECT project_id FROM app_database_resources WHERE ((status IN ('pending','error','configuration-required') AND (next_retry_at IS NULL OR next_retry_at<=?)) OR (status='ready' AND desired_schema_version<>schema_version)) ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'error' THEN 1 WHEN 'configuration-required' THEN 2 ELSE 3 END,updated_at ASC LIMIT ?`).bind(now, boundedLimit).all<D1Row>();
  const ready: string[] = [];
  const failed: Array<{ projectId: string; error: string }> = [];
  const skipped: string[] = [];
  for (const row of candidates.results ?? []) {
    const candidateProjectId = String(row.project_id);
    try {
      const resource = await ensureProjectDatabase(candidateProjectId);
      if (resource.status === "ready") ready.push(candidateProjectId);
      else skipped.push(candidateProjectId);
    } catch (error) {
      failed.push({ projectId: candidateProjectId, error: error instanceof Error ? error.message : "Provisioner 调和失败" });
    }
  }
  return { configured: true, attempted: candidates.results?.length ?? 0, ready, failed, skipped };
}

export async function scheduleProjectDatabaseDeletion(projectId: string, retentionDays = 30): Promise<AppDatabaseResource> {
  await ensureSchema();
  const days = Math.max(1, Math.min(365, Math.floor(retentionDays)));
  const retentionUntil = new Date(Date.now() + days * 86_400_000).toISOString();
  const now = new Date().toISOString();
  const result = await controlDatabase().prepare(`UPDATE app_database_resources SET status='deletion-scheduled',retention_until=?,updated_at=? WHERE project_id=? AND status IN ('ready','error','configuration-required')`).bind(retentionUntil, now, projectId).run();
  if (Number(result.meta.changes ?? 0) !== 1) throw new DatabaseProvisioningError("数据库不存在、正在处理或已删除", 409);
  await recordProvisioningEvent(projectId, "schedule-delete", "completed", { retentionDays: days, retentionUntil }, now);
  return (await getDatabaseResource(projectId))!;
}

export async function cancelProjectDatabaseDeletion(projectId: string): Promise<AppDatabaseResource> {
  await ensureSchema();
  const missingResourceStatus = configuration() ? "pending" : "configuration-required";
  const row = await controlDatabase().prepare(`UPDATE app_database_resources SET status=CASE WHEN external_database_id IS NULL THEN ? ELSE 'ready' END,retention_until=NULL,updated_at=? WHERE project_id=? AND status='deletion-scheduled' RETURNING *`).bind(missingResourceStatus, new Date().toISOString(), projectId).first<D1Row>();
  if (!row) throw new DatabaseProvisioningError("没有待取消的数据库删除计划", 409);
  return resourceFromRow(row);
}

export async function deleteDueProjectDatabases(limit = 20): Promise<{ deleted: string[]; failed: Array<{ projectId: string; error: string }> }> {
  await ensureSchema();
  const config = configuration();
  const result = await controlDatabase().prepare(`SELECT * FROM app_database_resources WHERE status='deletion-scheduled' AND retention_until<=? ORDER BY retention_until ASC LIMIT ?`).bind(new Date().toISOString(), Math.max(1, Math.min(100, limit))).all<D1Row>();
  const deleted: string[] = [];
  const failed: Array<{ projectId: string; error: string }> = [];
  for (const row of result.results ?? []) {
    const resource = resourceFromRow(row);
    const eventId = await startProvisioningEvent(resource.projectId, "delete", { externalDatabaseId: resource.externalDatabaseId });
    try {
      if (resource.externalDatabaseId) {
        if (!config) throw new DatabaseProvisioningError("数据库清理任务缺少 Cloudflare Provisioner 凭据", 503, true);
        await cloudflareRequest<unknown>(config, `/d1/database/${encodeURIComponent(resource.externalDatabaseId)}`, { method: "DELETE" });
      }
      const now = new Date().toISOString();
      await controlDatabase().batch([
        controlDatabase().prepare(`UPDATE app_database_resources SET status='deleted',external_database_id=NULL,next_retry_at=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=? WHERE project_id=?`).bind(now, resource.projectId),
        controlDatabase().prepare(`UPDATE provisioning_events SET status='completed',completed_at=? WHERE id=?`).bind(now, eventId),
      ]);
      deleted.push(resource.projectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除失败";
      await controlDatabase().batch([
        controlDatabase().prepare(`UPDATE app_database_resources SET status='deletion-scheduled',last_error=?,updated_at=? WHERE project_id=?`).bind(message.slice(0, 800), new Date().toISOString(), resource.projectId),
        controlDatabase().prepare(`UPDATE provisioning_events SET status='failed',detail_json=?,completed_at=? WHERE id=?`).bind(JSON.stringify({ error: message.slice(0, 800) }), new Date().toISOString(), eventId),
      ]);
      failed.push({ projectId: resource.projectId, error: message });
    }
  }
  return { deleted, failed };
}

export async function getPhysicalDatabase(projectId: string): Promise<AppDatabaseResource | null> {
  const resource = await getDatabaseResource(projectId);
  return resource?.status === "ready" && resource.externalDatabaseId && configuration() ? resource : null;
}

export async function listPhysicalRecords(resource: AppDatabaseResource, collectionName: string, actorId: string, ownerOnly: boolean, limit: number): Promise<AppRecord[]> {
  const table = collectionTable(collectionName);
  const result = await queryProjectDatabase(resource, `SELECT * FROM ${table} WHERE deleted_at IS NULL${ownerOnly ? " AND owner_subject=?" : ""} ORDER BY updated_at DESC LIMIT ?`, ownerOnly ? [actorId, limit] : [limit]);
  return result.rows.map((row) => physicalRecordFromRow(resource.projectId, collectionName, row));
}

export async function getPhysicalRecord(resource: AppDatabaseResource, collectionName: string, recordId: string): Promise<AppRecord | null> {
  const result = await queryProjectDatabase(resource, `SELECT * FROM ${collectionTable(collectionName)} WHERE id=? AND deleted_at IS NULL LIMIT 1`, [recordId]);
  return result.rows[0] ? physicalRecordFromRow(resource.projectId, collectionName, result.rows[0]) : null;
}

export async function insertPhysicalRecord(resource: AppDatabaseResource, collectionName: string, actorId: string, data: Record<string, unknown>): Promise<AppRecord> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const fields = Object.keys(data).map(safeIdentifier);
  const columns = ["id", "owner_subject", "data_json", "revision", "created_at", "updated_at", ...fields].map(quoted).join(",");
  const values = [id, actorId, JSON.stringify(data), 1, now, now, ...fields.map((field) => encodeFieldValue(data[field]))];
  await queryProjectDatabase(resource, `INSERT INTO ${collectionTable(collectionName)} (${columns}) VALUES (${values.map(() => "?").join(",")})`, values);
  return { id, projectId: resource.projectId, collection: collectionName, ownerSubject: actorId, data, revision: 1, createdAt: now, updatedAt: now };
}

export async function updatePhysicalRecord(resource: AppDatabaseResource, collectionName: string, recordId: string, expectedRevision: number, data: Record<string, unknown>): Promise<AppRecord | null> {
  const fields = Object.keys(data).map(safeIdentifier);
  const now = new Date().toISOString();
  const assignments = ["data_json=?", "revision=revision+1", "updated_at=?", ...fields.map((field) => `${quoted(field)}=?`)];
  const values = [JSON.stringify(data), now, ...fields.map((field) => encodeFieldValue(data[field])), recordId, expectedRevision];
  const result = await queryProjectDatabase(resource, `UPDATE ${collectionTable(collectionName)} SET ${assignments.join(",")} WHERE id=? AND revision=? AND deleted_at IS NULL RETURNING *`, values);
  return result.rows[0] ? physicalRecordFromRow(resource.projectId, collectionName, result.rows[0]) : null;
}

export async function deletePhysicalRecord(resource: AppDatabaseResource, collectionName: string, recordId: string, expectedOwner: string | null): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await queryProjectDatabase(resource, `UPDATE ${collectionTable(collectionName)} SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=? AND deleted_at IS NULL${expectedOwner ? " AND owner_subject=?" : ""}`, expectedOwner ? [now, now, recordId, expectedOwner] : [now, now, recordId]);
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function countPhysicalRecords(resource: AppDatabaseResource): Promise<number> {
  const manifest = await readManifest(resource.projectId);
  if (!manifest) return 0;
  let total = 0;
  for (const collection of manifest.database.collections) {
    const result = await queryProjectDatabase(resource, `SELECT COUNT(*) AS count FROM ${collectionTable(collection.name)} WHERE deleted_at IS NULL`, []);
    total += Number(result.rows[0]?.count ?? 0);
  }
  return total;
}

export async function createPhysicalBookmark(resource: AppDatabaseResource): Promise<string> {
  const config = requireConfiguration();
  if (!resource.externalDatabaseId) throw new DatabaseProvisioningError("物理数据库 ID 不存在", 409);
  const result = await cloudflareRequest<{ bookmark?: string }>(config, `/d1/database/${encodeURIComponent(resource.externalDatabaseId)}/time_travel/bookmark`, { method: "GET" });
  if (!result.bookmark) throw new DatabaseProvisioningError("Cloudflare 没有返回 Time Travel 书签", 502, true);
  await controlDatabase().prepare(`UPDATE app_database_resources SET last_backup_at=?,updated_at=? WHERE project_id=?`).bind(new Date().toISOString(), new Date().toISOString(), resource.projectId).run();
  return result.bookmark;
}

export async function restorePhysicalBookmark(resource: AppDatabaseResource, bookmark: string): Promise<void> {
  const config = requireConfiguration();
  if (!resource.externalDatabaseId) throw new DatabaseProvisioningError("物理数据库 ID 不存在", 409);
  if (!/^[a-zA-Z0-9_.:/-]{1,300}$/.test(bookmark)) throw new DatabaseProvisioningError("Time Travel 书签格式无效");
  await cloudflareRequest<unknown>(config, `/d1/database/${encodeURIComponent(resource.externalDatabaseId)}/time_travel/restore?bookmark=${encodeURIComponent(bookmark)}`, { method: "POST" });
}

export async function exportPhysicalDatabaseSql(resource: AppDatabaseResource): Promise<{ response: Response; bookmark: string; filename: string }> {
  const config = requireConfiguration();
  if (!resource.externalDatabaseId) throw new DatabaseProvisioningError("物理数据库 ID 不存在", 409);
  const path = `/d1/database/${encodeURIComponent(resource.externalDatabaseId)}/export`;
  let bookmark: string | null = null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const exportState: DatabaseExportResult = await cloudflareRequest<DatabaseExportResult>(config, path, {
      method: "POST",
      body: { output_format: "polling", ...(bookmark ? { current_bookmark: bookmark } : {}) },
    });
    if (exportState.status === "error" || exportState.success === false || exportState.error) throw new DatabaseProvisioningError(exportState.error || "D1 SQL 导出失败", 502, true);
    bookmark = exportState.at_bookmark ?? bookmark;
    const signedUrl = exportState.result?.signed_url;
    if (exportState.status === "complete" && signedUrl) {
      let url: URL;
      try { url = new URL(signedUrl); } catch { throw new DatabaseProvisioningError("D1 SQL 导出地址无效", 502, true); }
      if (url.protocol !== "https:") throw new DatabaseProvisioningError("D1 SQL 导出地址必须使用 HTTPS", 502, true);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("D1 export download timed out", "TimeoutError")), 60_000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok || !response.body) throw new DatabaseProvisioningError(`D1 SQL 下载失败：${response.status}`, 502, true);
        return { response, bookmark: bookmark ?? "", filename: exportState.result?.filename ?? `${resource.databaseName}.sql` };
      } finally {
        clearTimeout(timer);
      }
    }
    if (!bookmark) throw new DatabaseProvisioningError("D1 SQL 导出没有返回轮询书签", 502, true);
    await delay(Math.min(1_000, 250 + attempt * 50));
  }
  throw new DatabaseProvisioningError("D1 SQL 导出在轮询时限内未完成，将由下一次维护任务重试", 504, true);
}

async function migratePhysicalDatabase(config: NonNullable<ReturnType<typeof configuration>>, databaseId: string, manifest: AppManifest): Promise<number> {
  const schemaVersion = await databaseSchemaRevision(manifest);
  await remoteQuery(config, databaseId, `CREATE TABLE IF NOT EXISTS _nucleus_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)`, []);
  for (const collection of manifest.database.collections) {
    const table = collectionTable(collection.name);
    const fieldDefinitions = collection.fields.map((field) => `${quoted(safeIdentifier(field.name))} ${fieldSqlType(field.type)}`);
    await remoteQuery(config, databaseId, `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY,owner_subject TEXT NOT NULL,data_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,deleted_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL${fieldDefinitions.length ? `,${fieldDefinitions.join(",")}` : ""})`, []);
    const info = await remoteQuery(config, databaseId, `PRAGMA table_info(${table})`, []);
    const columns = new Set(info.rows.map((row) => String(row.name)));
    for (const field of collection.fields) {
      const name = safeIdentifier(field.name);
      if (!columns.has(name)) await remoteQuery(config, databaseId, `ALTER TABLE ${table} ADD COLUMN ${quoted(name)} ${fieldSqlType(field.type)}`, []);
    }
    await remoteQuery(config, databaseId, `CREATE INDEX IF NOT EXISTS ${quoted(`idx_${collection.name}_owner_updated`)} ON ${table}(owner_subject,updated_at)`, []);
    await remoteQuery(config, databaseId, `CREATE INDEX IF NOT EXISTS ${quoted(`idx_${collection.name}_updated`)} ON ${table}(updated_at)`, []);
  }
  await remoteQuery(config, databaseId, `INSERT INTO _nucleus_meta (key,value,updated_at) VALUES ('manifest',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, [JSON.stringify(manifest), new Date().toISOString()]);
  return schemaVersion;
}

async function migrateLogicalRecords(config: NonNullable<ReturnType<typeof configuration>>, databaseId: string, manifest: AppManifest, projectId: string): Promise<number> {
  const collections = new Map(manifest.database.collections.map((collection) => [collection.name, collection]));
  let migrated = 0;
  let cursorCreatedAt = "";
  let cursorId = "";
  while (true) {
    const legacy = await controlDatabase().prepare(`SELECT * FROM app_records WHERE project_id=? AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at ASC,id ASC LIMIT 500`).bind(projectId, cursorCreatedAt, cursorCreatedAt, cursorId).all<D1Row>();
    const rows = legacy.results ?? [];
    if (rows.length === 0) break;
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    for (const row of rows) {
      cursorCreatedAt = String(row.created_at);
      cursorId = String(row.id);
      const collectionName = String(row.collection);
      const collection = collections.get(collectionName);
      if (!collection) continue;
      let data: Record<string, unknown> = {};
      try { data = typeof row.data_json === "string" ? JSON.parse(row.data_json) as Record<string, unknown> : {}; } catch { continue; }
      const fields = collection.fields.map((field) => field.name).filter((name) => Object.prototype.hasOwnProperty.call(data, name)).map(safeIdentifier);
      const table = collectionTable(collectionName);
      const columns = ["id", "owner_subject", "data_json", "revision", "deleted_at", "created_at", "updated_at", ...fields].map(quoted).join(",");
      const params = [String(row.id), String(row.owner_subject), JSON.stringify(data), Number(row.revision), row.deleted_at ? String(row.deleted_at) : null, String(row.created_at), String(row.updated_at), ...fields.map((field) => encodeFieldValue(data[field]))];
      const updates = ["owner_subject=excluded.owner_subject", "data_json=excluded.data_json", "revision=excluded.revision", "deleted_at=excluded.deleted_at", "updated_at=excluded.updated_at", ...fields.map((field) => `${quoted(field)}=excluded.${quoted(field)}`)];
      statements.push({ sql: `INSERT INTO ${table} (${columns}) VALUES (${params.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${updates.join(",")} WHERE excluded.revision>${table}.revision`, params });
    }
    for (let offset = 0; offset < statements.length; offset += 50) await remoteBatch(config, databaseId, statements.slice(offset, offset + 50));
    migrated += statements.length;
    if (rows.length < 500) break;
  }
  return migrated;
}

async function queryProjectDatabase(resource: AppDatabaseResource, sql: string, params: unknown[]): Promise<{ rows: D1Row[]; meta: Record<string, unknown> }> {
  if (!resource.externalDatabaseId) throw new DatabaseProvisioningError("物理数据库尚未创建", 409);
  return remoteQuery(requireConfiguration(), resource.externalDatabaseId, sql, params);
}

async function remoteQuery(config: NonNullable<ReturnType<typeof configuration>>, databaseId: string, sql: string, params: unknown[]): Promise<{ rows: D1Row[]; meta: Record<string, unknown> }> {
  const raw = await cloudflareRequest<RemoteQueryResult | RemoteQueryResult[]>(config, `/d1/database/${encodeURIComponent(databaseId)}/query`, { method: "POST", body: { sql, params } });
  const result = Array.isArray(raw) ? raw[0] : raw;
  if (!result || result.success === false || result.error) throw new DatabaseProvisioningError(result?.error || "D1 Query 执行失败", 502, true);
  return { rows: result.results ?? [], meta: result.meta ?? {} };
}

async function remoteBatch(config: NonNullable<ReturnType<typeof configuration>>, databaseId: string, batch: Array<{ sql: string; params: unknown[] }>): Promise<void> {
  if (batch.length === 0) return;
  const results = await cloudflareRequest<RemoteQueryResult[]>(config, `/d1/database/${encodeURIComponent(databaseId)}/query`, { method: "POST", body: { batch } });
  const failed = results.find((result) => result.success === false || result.error);
  if (failed) throw new DatabaseProvisioningError(failed.error || "D1 Batch Migration 执行失败", 502, true);
}

async function cloudflareRequest<T>(config: NonNullable<ReturnType<typeof configuration>>, path: string, options: { method: string; body?: unknown }): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Cloudflare API timed out", "TimeoutError")), 25_000);
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}${path}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const envelope = await response.json().catch(() => ({})) as CloudflareEnvelope<T>;
    if (!response.ok || envelope.success === false || envelope.result === undefined) {
      const message = envelope.errors?.map((item) => item.message).filter(Boolean).join("；") || envelope.messages?.map((item) => item.message).filter(Boolean).join("；") || `Cloudflare API 返回 ${response.status}`;
      throw new DatabaseProvisioningError(message, response.status === 401 || response.status === 403 ? 503 : 502, response.status >= 429 || response.status >= 500);
    }
    return envelope.result;
  } catch (error) {
    if (error instanceof DatabaseProvisioningError) throw error;
    throw new DatabaseProvisioningError(error instanceof Error ? error.message : "Cloudflare API 请求失败", 502, true);
  } finally {
    clearTimeout(timer);
  }
}

async function readManifest(projectId: string): Promise<AppManifest | null> {
  const row = await controlDatabase().prepare(`SELECT manifest_json FROM app_manifests WHERE project_id=? AND status='active'`).bind(projectId).first<D1Row>();
  if (typeof row?.manifest_json !== "string") return null;
  try { return JSON.parse(row.manifest_json) as AppManifest; } catch { return null; }
}

async function updateManifestDatabaseState(projectId: string, state: AppManifest["capabilities"]["physicalDatabase"]): Promise<void> {
  const row = await controlDatabase().prepare(`SELECT manifest_json FROM app_manifests WHERE project_id=?`).bind(projectId).first<D1Row>();
  if (typeof row?.manifest_json !== "string") return;
  try {
    const manifest = JSON.parse(row.manifest_json) as AppManifest;
    manifest.capabilities.physicalDatabase = state;
    if (state === "ready") {
      manifest.database.provider = "cloudflare-d1";
      manifest.database.isolation = "physical-database";
    } else if (manifest.database.provider !== "cloudflare-d1") {
      manifest.database.provider = "nucleus-d1";
      manifest.database.isolation = "project-namespace";
    }
    await controlDatabase().prepare(`UPDATE app_manifests SET manifest_json=?,updated_at=? WHERE project_id=?`).bind(JSON.stringify(manifest), new Date().toISOString(), projectId).run();
  } catch { /* Keep the last valid manifest when an older row cannot be parsed. */ }
}

async function startProvisioningEvent(projectId: string, operation: ProvisioningEvent["operation"], detail: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID();
  await controlDatabase().prepare(`INSERT INTO provisioning_events (id,project_id,operation,status,provider,detail_json,started_at,completed_at) VALUES (?,?,?,'running','cloudflare-d1',?,?,NULL)`).bind(id, projectId, operation, JSON.stringify(detail), new Date().toISOString()).run();
  return id;
}

async function recordProvisioningEvent(projectId: string, operation: ProvisioningEvent["operation"], status: ProvisioningEvent["status"], detail: Record<string, unknown>, startedAt = new Date().toISOString()): Promise<void> {
  await controlDatabase().prepare(`INSERT INTO provisioning_events (id,project_id,operation,status,provider,detail_json,started_at,completed_at) VALUES (?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), projectId, operation, status, "cloudflare-d1", JSON.stringify(detail), startedAt, new Date().toISOString()).run();
}

function resourceFromRow(row: D1Row): AppDatabaseResource {
  return {
    projectId: String(row.project_id),
    provider: "cloudflare-d1",
    isolation: "physical-database",
    status: String(row.status) as AppDatabaseResource["status"],
    externalDatabaseId: row.external_database_id ? String(row.external_database_id) : null,
    databaseName: String(row.database_name),
    locationHint: row.location_hint ? String(row.location_hint) : null,
    schemaVersion: Number(row.schema_version ?? 0),
    desiredSchemaVersion: Number(row.desired_schema_version ?? row.schema_version ?? 0),
    attemptCount: Number(row.attempt_count ?? 0),
    nextRetryAt: row.next_retry_at ? String(row.next_retry_at) : null,
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
    lastMigrationAt: row.last_migration_at ? String(row.last_migration_at) : null,
    lastBackupAt: row.last_backup_at ? String(row.last_backup_at) : null,
    retentionUntil: row.retention_until ? String(row.retention_until) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function eventFromRow(row: D1Row): ProvisioningEvent {
  let detail: Record<string, unknown> = {};
  try { detail = typeof row.detail_json === "string" ? JSON.parse(row.detail_json) as Record<string, unknown> : {}; } catch { /* ignore malformed historical audit */ }
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    operation: String(row.operation) as ProvisioningEvent["operation"],
    status: String(row.status) as ProvisioningEvent["status"],
    provider: "cloudflare-d1",
    detail,
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

function physicalRecordFromRow(projectId: string, collection: string, row: D1Row): AppRecord {
  let data: Record<string, unknown> = {};
  try { data = typeof row.data_json === "string" ? JSON.parse(row.data_json) as Record<string, unknown> : {}; } catch { /* malformed data remains isolated to this row */ }
  return {
    id: String(row.id), projectId, collection, ownerSubject: String(row.owner_subject), data,
    revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function physicalDatabaseName(projectId: string): string {
  const suffix = projectId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || crypto.randomUUID().slice(0, 12);
  return `nucleus-${suffix}`.slice(0, 62);
}

function collectionTable(collectionName: string): string {
  return quoted(`app_${safeIdentifier(collectionName)}`);
}

function safeIdentifier(value: string): string {
  if (!/^[a-z][a-zA-Z0-9_]{0,39}$/.test(value)) throw new DatabaseProvisioningError(`不安全的 Schema 标识符：${value}`, 409);
  return value;
}

function quoted(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function fieldSqlType(type: AppManifest["database"]["collections"][number]["fields"][number]["type"]): string {
  if (type === "number") return "REAL";
  if (type === "boolean") return "INTEGER";
  return "TEXT";
}

function encodeFieldValue(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  return JSON.stringify(value);
}

function requireConfiguration(): NonNullable<ReturnType<typeof configuration>> {
  const config = configuration();
  if (!config) throw new DatabaseProvisioningError("物理数据库 Provisioner 尚未配置", 503);
  return config;
}

function stringEnv(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
