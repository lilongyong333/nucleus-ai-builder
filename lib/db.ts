import { env } from "cloudflare:workers";
import { starterFiles } from "./runtime";
import type { AgentPlan, AppQualityReport, GeneratedFiles, Project, ProjectVersion } from "./types";

type D1Row = Record<string, string | number | null>;

function db(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error("云端数据库暂不可用");
  return binding;
}

let schemaReady: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    const d1 = db();
    const pending = d1.batch([
      d1.prepare(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, plan_json TEXT, files_json TEXT NOT NULL, current_version_id TEXT, slug TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version_number INTEGER NOT NULL, files_json TEXT NOT NULL, summary TEXT NOT NULL, model TEXT NOT NULL, quality_json TEXT, created_at TEXT NOT NULL)`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)`),
      d1.prepare(`CREATE INDEX IF NOT EXISTS idx_versions_project_created ON versions(project_id, created_at)`),
      d1.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_project_created ON messages(project_id, created_at)`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS generation_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL)`),
      d1.prepare(`CREATE INDEX IF NOT EXISTS idx_generation_limits_expires ON generation_limits(expires_at)`),
    ]).then(() => undefined).catch((error: unknown) => { schemaReady = null; throw error; });
    schemaReady = pending;
  }
  return schemaReady as Promise<void>;
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function versionFromRow(row: D1Row): ProjectVersion {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    versionNumber: Number(row.version_number),
    files: json(row.files_json, starterFiles),
    summary: String(row.summary),
    model: String(row.model),
    quality: json<AppQualityReport | null>(row.quality_json, null),
    createdAt: String(row.created_at),
  };
}

async function projectFromRow(row: D1Row): Promise<Project> {
  const result = await db().prepare(`SELECT * FROM versions WHERE project_id = ? ORDER BY version_number DESC`).bind(String(row.id)).all<D1Row>();
  return {
    id: String(row.id),
    title: String(row.title),
    prompt: String(row.prompt),
    status: String(row.status) as Project["status"],
    plan: json<AgentPlan | null>(row.plan_json, null),
    files: json<GeneratedFiles>(row.files_json, starterFiles),
    currentVersionId: row.current_version_id ? String(row.current_version_id) : null,
    slug: row.slug ? String(row.slug) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    versions: (result.results ?? []).map(versionFromRow),
  };
}

export async function createProject(prompt: string): Promise<Project> {
  await ensureSchema();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const title = prompt.slice(0, 38) || "未命名应用";
  await db().batch([
    db().prepare(`INSERT INTO projects (id,title,prompt,status,files_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(id, title, prompt, "draft", JSON.stringify(starterFiles), now, now),
    db().prepare(`INSERT INTO messages (id,project_id,role,content,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), id, "user", prompt, now),
  ]);
  return (await getProject(id))!;
}

export async function getProject(id: string): Promise<Project | null> {
  await ensureSchema();
  const row = await db().prepare(`SELECT * FROM projects WHERE id = ?`).bind(id).first<D1Row>();
  return row ? projectFromRow(row) : null;
}

export async function listProjects(): Promise<Project[]> {
  await ensureSchema();
  const rows = await db().prepare(`SELECT * FROM projects ORDER BY updated_at DESC LIMIT 20`).all<D1Row>();
  return Promise.all((rows.results ?? []).map(projectFromRow));
}

export async function markGenerating(id: string, prompt: string): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  await db().batch([
    db().prepare(`UPDATE projects SET status='generating', prompt=?, updated_at=? WHERE id=?`).bind(prompt, now, id),
    db().prepare(`INSERT INTO messages (id,project_id,role,content,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), id, "user", prompt, now),
  ]);
}

export async function saveGeneration(id: string, plan: AgentPlan, files: GeneratedFiles, summary: string, model: string, quality: AppQualityReport): Promise<Project> {
  await ensureSchema();
  const count = await db().prepare(`SELECT COUNT(*) AS total FROM versions WHERE project_id=?`).bind(id).first<{ total: number }>();
  const versionNumber = Number(count?.total ?? 0) + 1;
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db().batch([
    db().prepare(`INSERT INTO versions (id,project_id,version_number,files_json,summary,model,quality_json,created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(versionId, id, versionNumber, JSON.stringify(files), summary, model, JSON.stringify(quality), now),
    db().prepare(`UPDATE projects SET title=?, status='ready', plan_json=?, files_json=?, current_version_id=?, updated_at=? WHERE id=?`).bind(plan.appName, JSON.stringify(plan), JSON.stringify(files), versionId, now, id),
    db().prepare(`INSERT INTO messages (id,project_id,role,content,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), id, "assistant", summary, now),
  ]);
  return (await getProject(id))!;
}

export async function markError(id: string): Promise<void> {
  await ensureSchema();
  await db().prepare(`UPDATE projects SET status='error', updated_at=? WHERE id=?`).bind(new Date().toISOString(), id).run();
}

export async function restoreVersion(projectId: string, versionId: string): Promise<Project | null> {
  await ensureSchema();
  const version = await db().prepare(`SELECT * FROM versions WHERE id=? AND project_id=?`).bind(versionId, projectId).first<D1Row>();
  if (!version) return null;
  await db().prepare(`UPDATE projects SET files_json=?, current_version_id=?, status='ready', updated_at=? WHERE id=?`).bind(String(version.files_json), versionId, new Date().toISOString(), projectId).run();
  return getProject(projectId);
}

export async function publishProject(id: string): Promise<Project | null> {
  await ensureSchema();
  const current = await getProject(id);
  if (!current) return null;
  const slug = current.slug ?? `${current.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 26) || "app"}-${id.slice(0, 6)}`;
  await db().prepare(`UPDATE projects SET slug=?, updated_at=? WHERE id=?`).bind(slug, new Date().toISOString(), id).run();
  return getProject(id);
}

export async function getPublishedProject(slug: string): Promise<Project | null> {
  await ensureSchema();
  const row = await db().prepare(`SELECT * FROM projects WHERE slug=?`).bind(slug).first<D1Row>();
  return row ? projectFromRow(row) : null;
}

export async function consumeGenerationQuota(identifier: string, limit = 8): Promise<boolean> {
  await ensureSchema();
  const now = new Date();
  const bucket = now.toISOString().slice(0, 13);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identifier));
  const fingerprint = Array.from(new Uint8Array(digest)).slice(0, 12).map((value) => value.toString(16).padStart(2, "0")).join("");
  const key = `${bucket}:${fingerprint}`;
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  const d1 = db();
  await d1.prepare(`DELETE FROM generation_limits WHERE expires_at < ?`).bind(now.toISOString()).run();
  const row = await d1.prepare(`INSERT INTO generation_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`).bind(key, expiresAt).first<{ count: number }>();
  return Number(row?.count ?? limit + 1) <= limit;
}
