import { env } from "cloudflare:workers";
import { starterFiles } from "./runtime";
import type { AgentName, AgentPlan, AppQualityReport, GeneratedFiles, GenerationArtifact, GenerationArtifactKind, GenerationEvent, GenerationRun, GenerationStage, ModelAttemptRecord, ModelUsage, Project, ProjectMessage, ProjectVersion } from "./types";

type D1Row = Record<string, string | number | null>;

function db(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error("云端数据库暂不可用");
  return binding;
}

let schemaReady: Promise<void> | null = null;

async function prepareSchema(): Promise<void> {
  const d1 = db();
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner_id TEXT, title TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, plan_json TEXT, files_json TEXT NOT NULL, current_version_id TEXT, published_version_id TEXT, generation_id TEXT, generation_started_at TEXT, slug TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version_number INTEGER NOT NULL, files_json TEXT NOT NULL, summary TEXT NOT NULL, model TEXT NOT NULL, quality_json TEXT, created_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS generation_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS generation_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, duration_ms INTEGER, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, model_calls INTEGER NOT NULL DEFAULT 0, repair_count INTEGER NOT NULL DEFAULT 0, current_stage TEXT NOT NULL DEFAULT 'requirements', active_step TEXT, step_started_at TEXT, version_id TEXT, error TEXT)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agent_events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL, sequence INTEGER NOT NULL, agent TEXT NOT NULL, phase TEXT NOT NULL, state TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, duration_ms INTEGER, model TEXT, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS generation_artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS model_attempts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL, agent TEXT NOT NULL, phase TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER NOT NULL, first_token_ms INTEGER, output_chars INTEGER NOT NULL DEFAULT 0, status_code INTEGER, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL)`),
  ]);

  const info = await d1.prepare(`PRAGMA table_info(projects)`).all<{ name: string }>();
  const columns = new Set((info.results ?? []).map((column) => column.name));
  const additions = [
    ["owner_id", `ALTER TABLE projects ADD COLUMN owner_id TEXT`],
    ["published_version_id", `ALTER TABLE projects ADD COLUMN published_version_id TEXT`],
    ["generation_id", `ALTER TABLE projects ADD COLUMN generation_id TEXT`],
    ["generation_started_at", `ALTER TABLE projects ADD COLUMN generation_started_at TEXT`],
  ] as const;
  for (const [name, statement] of additions) {
    if (columns.has(name)) continue;
    try {
      await d1.prepare(statement).run();
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
    }
  }
  const runInfo = await d1.prepare(`PRAGMA table_info(generation_runs)`).all<{ name: string }>();
  const runColumns = new Set((runInfo.results ?? []).map((column) => column.name));
  const runAdditions = [
    ["current_stage", `ALTER TABLE generation_runs ADD COLUMN current_stage TEXT NOT NULL DEFAULT 'requirements'`],
    ["active_step", `ALTER TABLE generation_runs ADD COLUMN active_step TEXT`],
    ["step_started_at", `ALTER TABLE generation_runs ADD COLUMN step_started_at TEXT`],
  ] as const;
  for (const [name, statement] of runAdditions) {
    if (runColumns.has(name)) continue;
    try {
      await d1.prepare(statement).run();
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
    }
  }
  await d1.prepare(`UPDATE projects SET published_version_id=current_version_id WHERE slug IS NOT NULL AND current_version_id IS NOT NULL AND published_version_id IS NULL`).run();
  await d1.batch([
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_versions_project_created ON versions(project_id, created_at)`),
    d1.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_versions_project_number ON versions(project_id, version_number)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_project_created ON messages(project_id, created_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_projects_owner_updated ON projects(owner_id, updated_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_generation_limits_expires ON generation_limits(expires_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_generation_runs_project_started ON generation_runs(project_id, started_at)`),
    d1.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_events_run_sequence ON agent_events(run_id, sequence)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_events_project_created ON agent_events(project_id, created_at)`),
    d1.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_generation_artifacts_run_kind ON generation_artifacts(run_id, kind)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_generation_artifacts_project_run ON generation_artifacts(project_id, run_id)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_model_attempts_run_created ON model_attempts(run_id, created_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_model_attempts_project_created ON model_attempts(project_id, created_at)`),
  ]);
  await d1.prepare(`PRAGMA optimize`).run();
}

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    const pending = prepareSchema().catch((error: unknown) => { schemaReady = null; throw error; });
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

function usageFromRow(row: D1Row): ModelUsage {
  return {
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
  };
}

function eventFromRow(row: D1Row): GenerationEvent {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    projectId: String(row.project_id),
    sequence: Number(row.sequence),
    agent: String(row.agent),
    phase: String(row.phase),
    state: String(row.state) as GenerationEvent["state"],
    title: String(row.title),
    detail: String(row.detail),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    model: row.model ? String(row.model) : null,
    usage: usageFromRow(row),
    createdAt: String(row.created_at),
  };
}

function artifactFromRow(row: D1Row): GenerationArtifact {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    projectId: String(row.project_id),
    agent: String(row.agent) as AgentName,
    kind: String(row.kind) as GenerationArtifactKind,
    content: String(row.content),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function attemptFromRow(row: D1Row): ModelAttemptRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    projectId: String(row.project_id),
    agent: String(row.agent) as AgentName,
    phase: String(row.phase),
    model: String(row.model),
    status: String(row.status) as ModelAttemptRecord["status"],
    durationMs: Number(row.duration_ms ?? 0),
    firstTokenMs: row.first_token_ms === null ? null : Number(row.first_token_ms),
    outputChars: Number(row.output_chars ?? 0),
    statusCode: row.status_code === null ? null : Number(row.status_code),
    usage: usageFromRow(row),
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
  };
}

function runFromRow(row: D1Row, events: GenerationEvent[], artifacts: GenerationArtifact[] = [], attempts: ModelAttemptRecord[] = []): GenerationRun {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    prompt: String(row.prompt),
    status: String(row.status) as GenerationRun["status"],
    model: String(row.model),
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    usage: usageFromRow(row),
    modelCalls: Number(row.model_calls ?? 0),
    repairCount: Number(row.repair_count ?? 0),
    versionId: row.version_id ? String(row.version_id) : null,
    error: row.error ? String(row.error) : null,
    currentStage: (String(row.status) === "completed" ? "completed" : String(row.current_stage ?? "requirements")) as GenerationStage,
    events,
    artifacts,
    attempts,
  };
}

function messageFromRow(row: D1Row): ProjectMessage {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    role: String(row.role) as ProjectMessage["role"],
    content: String(row.content),
    createdAt: String(row.created_at),
  };
}

async function projectFromRow(row: D1Row, includeAudit = true): Promise<Project> {
  const result = await db().prepare(`SELECT * FROM versions WHERE project_id = ? ORDER BY version_number DESC`).bind(String(row.id)).all<D1Row>();
  let runs: GenerationRun[] = [];
  let messages: ProjectMessage[] = [];
  if (includeAudit) {
    const runRows = await db().prepare(`SELECT * FROM generation_runs WHERE project_id=? ORDER BY started_at DESC LIMIT 10`).bind(String(row.id)).all<D1Row>();
    const eventRows = await db().prepare(`SELECT * FROM agent_events WHERE project_id=? ORDER BY created_at DESC LIMIT 200`).bind(String(row.id)).all<D1Row>();
    const artifactRows = await db().prepare(`SELECT * FROM generation_artifacts WHERE project_id=? ORDER BY created_at ASC LIMIT 200`).bind(String(row.id)).all<D1Row>();
    const attemptRows = await db().prepare(`SELECT * FROM model_attempts WHERE project_id=? ORDER BY created_at DESC LIMIT 200`).bind(String(row.id)).all<D1Row>();
    const events = (eventRows.results ?? []).map(eventFromRow);
    const artifacts = (artifactRows.results ?? []).map(artifactFromRow);
    const attempts = (attemptRows.results ?? []).map(attemptFromRow);
    runs = (runRows.results ?? []).map((run) => runFromRow(
      run,
      events.filter((event) => event.runId === String(run.id)).sort((a, b) => a.sequence - b.sequence),
      artifacts.filter((artifact) => artifact.runId === String(run.id)),
      attempts.filter((attempt) => attempt.runId === String(run.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    ));
    const messageRows = await db().prepare(`SELECT * FROM (SELECT * FROM messages WHERE project_id=? ORDER BY created_at DESC LIMIT 100) ORDER BY created_at ASC`).bind(String(row.id)).all<D1Row>();
    messages = (messageRows.results ?? []).map(messageFromRow);
  }
  return {
    id: String(row.id),
    title: String(row.title),
    prompt: String(row.prompt),
    status: String(row.status) as Project["status"],
    plan: json<AgentPlan | null>(row.plan_json, null),
    files: json<GeneratedFiles>(row.files_json, starterFiles),
    currentVersionId: row.current_version_id ? String(row.current_version_id) : null,
    publishedVersionId: row.published_version_id ? String(row.published_version_id) : null,
    slug: row.slug ? String(row.slug) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    versions: (result.results ?? []).map(versionFromRow),
    runs,
    messages,
  };
}

export async function adoptVisitorProjects(visitorOwnerId: string, accountOwnerId: string): Promise<number> {
  if (!visitorOwnerId || !accountOwnerId || visitorOwnerId === accountOwnerId) return 0;
  await ensureSchema();
  const result = await db().prepare(`UPDATE projects SET owner_id=?, updated_at=? WHERE owner_id=?`).bind(accountOwnerId, new Date().toISOString(), visitorOwnerId).run();
  return Number(result.meta.changes ?? 0);
}

export async function createProject(prompt: string, ownerId: string): Promise<Project> {
  await ensureSchema();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const title = prompt.slice(0, 38) || "未命名应用";
  await db().batch([
    db().prepare(`INSERT INTO projects (id,owner_id,title,prompt,status,files_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(id, ownerId, title, prompt, "draft", JSON.stringify(starterFiles), now, now),
    db().prepare(`INSERT INTO messages (id,project_id,role,content,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), id, "user", prompt, now),
  ]);
  return (await getProject(id, ownerId))!;
}

export async function getProject(id: string, ownerId: string): Promise<Project | null> {
  await ensureSchema();
  await db().prepare(`UPDATE projects SET owner_id=? WHERE id=? AND owner_id IS NULL`).bind(ownerId, id).run();
  let row = await db().prepare(`SELECT * FROM projects WHERE id=? AND owner_id=?`).bind(id, ownerId).first<D1Row>();
  if (isStaleGeneration(row)) {
    await recoverStaleGenerations(ownerId, id);
    row = await db().prepare(`SELECT * FROM projects WHERE id=? AND owner_id=?`).bind(id, ownerId).first<D1Row>();
  }
  return row ? projectFromRow(row) : null;
}

export async function listProjects(ownerId: string): Promise<Project[]> {
  await ensureSchema();
  let rows = await db().prepare(`SELECT * FROM projects WHERE owner_id=? ORDER BY updated_at DESC LIMIT 20`).bind(ownerId).all<D1Row>();
  if ((rows.results ?? []).some(isStaleGeneration)) {
    await recoverStaleGenerations(ownerId);
    rows = await db().prepare(`SELECT * FROM projects WHERE owner_id=? ORDER BY updated_at DESC LIMIT 20`).bind(ownerId).all<D1Row>();
  }
  return Promise.all((rows.results ?? []).map((row) => projectFromRow(row, false)));
}

export type GenerationMetrics = {
  usage: ModelUsage;
  durationMs: number;
  modelCalls: number;
  repairCount: number;
  model: string;
};

type GenerationEventInput = {
  sequence: number;
  agent: string;
  phase: string;
  state: GenerationEvent["state"];
  title: string;
  detail: string;
  durationMs?: number;
  model?: string;
  usage?: ModelUsage;
};

export type PersistedModelAttemptInput = Omit<ModelAttemptRecord, "id" | "runId" | "projectId" | "agent" | "phase" | "createdAt">;

export async function beginGeneration(id: string, ownerId: string, prompt: string, model: string): Promise<string | null> {
  await ensureSchema();
  const generationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - GENERATION_LEASE_TTL_MS).toISOString();
  const locked = await db().prepare(`UPDATE projects SET status='generating', prompt=?, generation_id=?, generation_started_at=?, updated_at=? WHERE id=? AND owner_id=? AND (status!='generating' OR generation_started_at IS NULL OR generation_started_at<?) RETURNING id`).bind(prompt, generationId, now, now, id, ownerId, staleBefore).first<{ id: string }>();
  if (!locked) return null;
  try {
    await db().batch([
      db().prepare(`UPDATE generation_runs SET status='failed', completed_at=?, duration_ms=MAX(0,CAST((julianday(?) - julianday(started_at))*86400000 AS INTEGER)), error='生成租约过期，已由新任务回收' WHERE project_id=? AND status='running'`).bind(now, now, id),
      db().prepare(`INSERT INTO generation_runs (id,project_id,prompt,status,model,started_at) VALUES (?,?,?,?,?,?)`).bind(generationId, id, prompt, "running", model, now),
      db().prepare(`INSERT INTO messages (id,project_id,role,content,created_at) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM messages WHERE id=(SELECT id FROM messages WHERE project_id=? ORDER BY created_at DESC LIMIT 1) AND role='user' AND content=?)`).bind(crypto.randomUUID(), id, "user", prompt, now, id, prompt),
    ]);
  } catch (error) {
    await db().prepare(`UPDATE projects SET status=CASE WHEN current_version_id IS NULL THEN 'draft' ELSE 'ready' END, generation_id=NULL, generation_started_at=NULL, updated_at=? WHERE id=? AND owner_id=? AND generation_id=?`).bind(new Date().toISOString(), id, ownerId, generationId).run().catch(() => undefined);
    throw error;
  }
  return generationId;
}

// A multi-agent run spans several independently bounded requests. Each step
// refreshes this lease, while a genuinely abandoned run is reclaimed later.
const GENERATION_LEASE_TTL_MS = 30 * 60_000;

function isStaleGeneration(row: D1Row | null | undefined): boolean {
  if (!row || String(row.status) !== "generating" || !row.generation_started_at) return false;
  const startedAt = Date.parse(String(row.generation_started_at));
  return Number.isFinite(startedAt) && startedAt < Date.now() - GENERATION_LEASE_TTL_MS;
}

async function recoverStaleGenerations(ownerId: string, projectId?: string): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - GENERATION_LEASE_TTL_MS).toISOString();
  const scopedProjectId = projectId ?? null;
  const reason = "线上生成超过执行窗口，任务已自动回收，请重试";
  await db().batch([
    db().prepare(`UPDATE generation_runs SET status='failed', completed_at=?, duration_ms=MAX(0,CAST((julianday(?) - julianday(started_at))*86400000 AS INTEGER)), error=? WHERE id IN (SELECT generation_id FROM projects WHERE owner_id=? AND (? IS NULL OR id=?) AND status='generating' AND generation_id IS NOT NULL AND generation_started_at<?) AND status='running'`).bind(nowIso, nowIso, reason, ownerId, scopedProjectId, scopedProjectId, staleBefore),
    db().prepare(`UPDATE projects SET status=CASE WHEN current_version_id IS NULL THEN 'error' ELSE 'ready' END, generation_id=NULL, generation_started_at=NULL, updated_at=? WHERE owner_id=? AND (? IS NULL OR id=?) AND status='generating' AND generation_started_at<?`).bind(nowIso, ownerId, scopedProjectId, scopedProjectId, staleBefore),
  ]);
}

export async function recordGenerationEvent(runId: string, projectId: string, input: GenerationEventInput): Promise<GenerationEvent> {
  await ensureSchema();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const usage = input.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const result = await db().prepare(`INSERT INTO agent_events (id,run_id,project_id,sequence,agent,phase,state,title,detail,duration_ms,model,prompt_tokens,completion_tokens,total_tokens,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM generation_runs WHERE id=? AND project_id=? AND status='running')`).bind(id, runId, projectId, input.sequence, input.agent, input.phase, input.state, input.title, input.detail, input.durationMs ?? null, input.model ?? null, usage.promptTokens, usage.completionTokens, usage.totalTokens, now, runId, projectId).run();
  if (Number(result.meta.changes ?? 0) !== 1) throw new Error("生成任务已结束，拒绝迟到的执行事件");
  return { id, runId, projectId, sequence: input.sequence, agent: input.agent, phase: input.phase, state: input.state, title: input.title, detail: input.detail, durationMs: input.durationMs ?? null, model: input.model ?? null, usage, createdAt: now };
}

export async function recordNextGenerationEvent(runId: string, projectId: string, input: Omit<GenerationEventInput, "sequence">): Promise<GenerationEvent> {
  await ensureSchema();
  const row = await db().prepare(`SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM agent_events WHERE run_id=?`).bind(runId).first<{ sequence: number }>();
  return recordGenerationEvent(runId, projectId, { ...input, sequence: Number(row?.sequence ?? 1) });
}

export async function acquireGenerationStep(projectId: string, ownerId: string, runId: string): Promise<string | null> {
  await ensureSchema();
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 70_000).toISOString();
  const acquired = await db().prepare(`UPDATE generation_runs SET active_step=?,step_started_at=?,error=NULL WHERE id=? AND project_id=? AND status='running' AND (active_step IS NULL OR step_started_at IS NULL OR step_started_at<?) AND EXISTS (SELECT 1 FROM projects WHERE id=? AND owner_id=? AND generation_id=? AND status='generating') RETURNING id`).bind(token, now, runId, projectId, staleBefore, projectId, ownerId, runId).first<{ id: string }>();
  if (!acquired) return null;
  await db().prepare(`UPDATE projects SET generation_started_at=?,updated_at=? WHERE id=? AND owner_id=? AND generation_id=?`).bind(now, now, projectId, ownerId, runId).run();
  return token;
}

export async function releaseGenerationStep(runId: string, token: string): Promise<void> {
  await ensureSchema();
  await db().prepare(`UPDATE generation_runs SET active_step=NULL,step_started_at=NULL WHERE id=? AND active_step=?`).bind(runId, token).run();
}

export async function updateGenerationStage(runId: string, projectId: string, stage: GenerationStage): Promise<void> {
  await ensureSchema();
  await db().prepare(`UPDATE generation_runs SET current_stage=? WHERE id=? AND project_id=? AND status='running'`).bind(stage, runId, projectId).run();
}

export async function saveGenerationArtifact(runId: string, projectId: string, agent: AgentName, kind: GenerationArtifactKind, content: string): Promise<GenerationArtifact> {
  await ensureSchema();
  const active = await db().prepare(`SELECT id FROM generation_runs WHERE id=? AND project_id=? AND status='running'`).bind(runId, projectId).first<{ id: string }>();
  if (!active) throw new Error("生成任务已结束，拒绝迟到的工件");
  const existing = await db().prepare(`SELECT id,created_at FROM generation_artifacts WHERE run_id=? AND kind=?`).bind(runId, kind).first<{ id: string; created_at: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  await db().prepare(`INSERT INTO generation_artifacts (id,run_id,project_id,agent,kind,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(run_id,kind) DO UPDATE SET agent=excluded.agent,content=excluded.content,updated_at=excluded.updated_at`).bind(id, runId, projectId, agent, kind, content, existing?.created_at ?? now, now).run();
  return { id, runId, projectId, agent, kind, content, createdAt: existing?.created_at ?? now, updatedAt: now };
}

export async function listGenerationArtifacts(runId: string, projectId: string): Promise<GenerationArtifact[]> {
  await ensureSchema();
  const rows = await db().prepare(`SELECT * FROM generation_artifacts WHERE run_id=? AND project_id=? ORDER BY created_at ASC`).bind(runId, projectId).all<D1Row>();
  return (rows.results ?? []).map(artifactFromRow);
}

export async function recordModelAttempts(runId: string, projectId: string, agent: AgentName, phase: string, attempts: PersistedModelAttemptInput[]): Promise<void> {
  if (attempts.length === 0) return;
  await ensureSchema();
  const active = await db().prepare(`SELECT model FROM generation_runs WHERE id=? AND project_id=? AND status='running'`).bind(runId, projectId).first<{ model: string }>();
  if (!active) return;
  const now = new Date().toISOString();
  await db().batch(attempts.map((item) => db().prepare(`INSERT INTO model_attempts (id,run_id,project_id,agent,phase,model,status,duration_ms,first_token_ms,output_chars,status_code,prompt_tokens,completion_tokens,total_tokens,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), runId, projectId, agent, phase, item.model, item.status, item.durationMs, item.firstTokenMs, item.outputChars, item.statusCode, item.usage.promptTokens, item.usage.completionTokens, item.usage.totalTokens, item.error?.slice(0, 600) ?? null, now)));
  const usage = attempts.reduce((total, item) => ({ promptTokens: total.promptTokens + item.usage.promptTokens, completionTokens: total.completionTokens + item.usage.completionTokens, totalTokens: total.totalTokens + item.usage.totalTokens }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  const models = [...new Set([active.model, ...attempts.map((item) => item.model)].flatMap((value) => value.split(" → ")).filter(Boolean))];
  await db().prepare(`UPDATE generation_runs SET prompt_tokens=prompt_tokens+?,completion_tokens=completion_tokens+?,total_tokens=total_tokens+?,model_calls=model_calls+?,model=? WHERE id=? AND project_id=? AND status='running'`).bind(usage.promptTokens, usage.completionTokens, usage.totalTokens, attempts.length, models.join(" → "), runId, projectId).run();
}

export async function incrementGenerationRepair(runId: string, projectId: string): Promise<void> {
  await ensureSchema();
  await db().prepare(`UPDATE generation_runs SET repair_count=repair_count+1 WHERE id=? AND project_id=? AND status='running'`).bind(runId, projectId).run();
}

export async function saveGeneration(id: string, ownerId: string, generationId: string, plan: AgentPlan, files: GeneratedFiles, summary: string, model: string, quality: AppQualityReport, metrics: GenerationMetrics): Promise<Project> {
  await ensureSchema();
  const count = await db().prepare(`SELECT COUNT(*) AS total FROM versions WHERE project_id=?`).bind(id).first<{ total: number }>();
  const versionNumber = Number(count?.total ?? 0) + 1;
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await db().batch([
    db().prepare(`INSERT INTO versions (id,project_id,version_number,files_json,summary,model,quality_json,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM projects WHERE id=? AND owner_id=? AND generation_id=?) AND EXISTS (SELECT 1 FROM generation_runs WHERE id=? AND project_id=? AND status='running')`).bind(versionId, id, versionNumber, JSON.stringify(files), summary, model, JSON.stringify(quality), now, id, ownerId, generationId, generationId, id),
    db().prepare(`INSERT INTO messages (id,project_id,role,content,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM projects WHERE id=? AND owner_id=? AND generation_id=?) AND EXISTS (SELECT 1 FROM generation_runs WHERE id=? AND project_id=? AND status='running')`).bind(crypto.randomUUID(), id, "assistant", summary, now, id, ownerId, generationId, generationId, id),
    db().prepare(`UPDATE projects SET title=?, status='ready', plan_json=?, files_json=?, current_version_id=?, generation_id=NULL, generation_started_at=NULL, updated_at=? WHERE id=? AND owner_id=? AND generation_id=? AND EXISTS (SELECT 1 FROM generation_runs WHERE id=? AND project_id=? AND status='running')`).bind(plan.appName, JSON.stringify(plan), JSON.stringify(files), versionId, now, id, ownerId, generationId, generationId, id),
    db().prepare(`UPDATE generation_runs SET status='completed', current_stage='completed', active_step=NULL, step_started_at=NULL, completed_at=?, duration_ms=?, prompt_tokens=?, completion_tokens=?, total_tokens=?, model_calls=?, repair_count=?, model=?, version_id=?, error=NULL WHERE id=? AND project_id=? AND status='running'`).bind(now, metrics.durationMs, metrics.usage.promptTokens, metrics.usage.completionTokens, metrics.usage.totalTokens, metrics.modelCalls, metrics.repairCount, metrics.model, versionId, generationId, id),
  ]);
  if (Number(results[2]?.meta.changes ?? 0) !== 1 || Number(results[3]?.meta.changes ?? 0) !== 1) throw new Error("生成任务已过期，请重新开始");
  return (await getProject(id, ownerId))!;
}

export async function markError(id: string, ownerId: string, generationId: string, error: string, metrics: GenerationMetrics): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  await db().batch([
    db().prepare(`UPDATE projects SET status='error', generation_id=NULL, generation_started_at=NULL, updated_at=? WHERE id=? AND owner_id=? AND generation_id=?`).bind(now, id, ownerId, generationId),
    db().prepare(`UPDATE generation_runs SET status='failed', active_step=NULL, step_started_at=NULL, completed_at=?, duration_ms=?, prompt_tokens=?, completion_tokens=?, total_tokens=?, model_calls=?, repair_count=?, model=?, error=? WHERE id=? AND project_id=? AND status='running'`).bind(now, metrics.durationMs, metrics.usage.promptTokens, metrics.usage.completionTokens, metrics.usage.totalTokens, metrics.modelCalls, metrics.repairCount, metrics.model, error.slice(0, 600), generationId, id),
  ]);
}

export async function releaseGeneration(id: string, ownerId: string, generationId: string, status: "draft" | "ready", reason = "生成任务已释放", runStatus: "rejected" | "cancelled" = "rejected"): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  await db().batch([
    db().prepare(`UPDATE projects SET status=?, generation_id=NULL, generation_started_at=NULL, updated_at=? WHERE id=? AND owner_id=? AND generation_id=?`).bind(status, now, id, ownerId, generationId),
    db().prepare(`UPDATE generation_runs SET status=?, active_step=NULL, step_started_at=NULL, completed_at=?, duration_ms=MAX(0,CAST((julianday(?) - julianday(started_at))*86400000 AS INTEGER)), error=? WHERE id=? AND project_id=? AND status='running'`).bind(runStatus, now, now, reason.slice(0, 600), generationId, id),
  ]);
}

export async function cancelGeneration(id: string, ownerId: string): Promise<string | null> {
  await ensureSchema();
  const active = await db().prepare(`SELECT generation_id,generation_started_at FROM projects WHERE id=? AND owner_id=? AND status='generating' AND generation_id IS NOT NULL`).bind(id, ownerId).first<{ generation_id: string; generation_started_at: string | null }>();
  if (!active?.generation_id) return null;
  const now = new Date();
  const durationMs = active.generation_started_at ? Math.max(0, now.getTime() - new Date(active.generation_started_at).getTime()) : null;
  const results = await db().batch([
    db().prepare(`UPDATE projects SET status=CASE WHEN current_version_id IS NULL THEN 'draft' ELSE 'ready' END, generation_id=NULL, generation_started_at=NULL, updated_at=? WHERE id=? AND owner_id=? AND generation_id=?`).bind(now.toISOString(), id, ownerId, active.generation_id),
    db().prepare(`UPDATE generation_runs SET status='cancelled', active_step=NULL, step_started_at=NULL, completed_at=?, duration_ms=?, error='用户取消生成' WHERE id=? AND project_id=? AND status='running'`).bind(now.toISOString(), durationMs, active.generation_id, id),
  ]);
  return Number(results[0]?.meta.changes ?? 0) === 1 ? active.generation_id : null;
}

export async function restoreVersion(projectId: string, ownerId: string, versionId: string): Promise<Project | null> {
  await ensureSchema();
  const owned = await getProject(projectId, ownerId);
  if (!owned || owned.status === "generating") return null;
  const version = await db().prepare(`SELECT * FROM versions WHERE id=? AND project_id=?`).bind(versionId, projectId).first<D1Row>();
  if (!version) return null;
  await db().prepare(`UPDATE projects SET files_json=?, current_version_id=?, status='ready', updated_at=? WHERE id=? AND owner_id=?`).bind(String(version.files_json), versionId, new Date().toISOString(), projectId, ownerId).run();
  return getProject(projectId, ownerId);
}

export async function publishProject(id: string, ownerId: string): Promise<Project | null> {
  await ensureSchema();
  const current = await getProject(id, ownerId);
  if (!current?.currentVersionId || current.status === "generating") return null;
  const slug = current.slug ?? `${current.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 26) || "app"}-${id.slice(0, 6)}`;
  await db().prepare(`UPDATE projects SET slug=?, published_version_id=?, updated_at=? WHERE id=? AND owner_id=?`).bind(slug, current.currentVersionId, new Date().toISOString(), id, ownerId).run();
  return getProject(id, ownerId);
}

export async function getPublishedProject(slug: string): Promise<Project | null> {
  await ensureSchema();
  const row = await db().prepare(`SELECT * FROM projects WHERE slug=?`).bind(slug).first<D1Row>();
  if (!row) return null;
  const project = await projectFromRow(row, false);
  const publishedVersionId = project.publishedVersionId ?? project.currentVersionId;
  const publishedVersion = project.versions.find((version) => version.id === publishedVersionId);
  if (!publishedVersion) return null;
  return { ...project, files: publishedVersion.files, currentVersionId: publishedVersion.id };
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
