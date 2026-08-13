import { env } from "cloudflare:workers";
import { buildAppManifest, defaultRuntimeBlueprint } from "./app-manifest";
import { databaseSchemaRevision } from "./database-schema";
import { starterFiles } from "./runtime";
import type { AgentName, AgentPlan, AppManifest, AppQualityReport, AppRuntimeBlueprint, GeneratedFiles, GenerationArtifact, GenerationArtifactKind, GenerationEvent, GenerationRun, GenerationStage, ModelAttemptRecord, ModelUsage, Project, ProjectIntake, ProjectMessage, ProjectVersion, RaceCandidate } from "./types";

type D1Row = Record<string, string | number | null>;

const PROJECT_READ_ACCESS = `(projects.owner_id=? OR EXISTS (SELECT 1 FROM organization_members access_member WHERE access_member.organization_id=projects.organization_id AND access_member.subject_id=? AND access_member.status='active'))`;
const PROJECT_EDIT_ACCESS = `(projects.owner_id=? OR EXISTS (SELECT 1 FROM organization_members access_member WHERE access_member.organization_id=projects.organization_id AND access_member.subject_id=? AND access_member.status='active' AND access_member.role IN ('owner','admin','editor')))`;
const PROJECT_READ_ACCESS_P = `(p.owner_id=? OR EXISTS (SELECT 1 FROM organization_members access_member WHERE access_member.organization_id=p.organization_id AND access_member.subject_id=? AND access_member.status='active'))`;
const PROJECT_EDIT_ACCESS_P = `(p.owner_id=? OR EXISTS (SELECT 1 FROM organization_members access_member WHERE access_member.organization_id=p.organization_id AND access_member.subject_id=? AND access_member.status='active' AND access_member.role IN ('owner','admin','editor')))`;

function db(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error("云端数据库暂不可用");
  return binding;
}

let schemaReady: Promise<void> | null = null;

async function prepareSchema(): Promise<void> {
  const d1 = db();
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner_id TEXT, title TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, plan_json TEXT, intake_json TEXT, files_json TEXT NOT NULL, current_version_id TEXT, published_version_id TEXT, generation_id TEXT, generation_started_at TEXT, slug TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version_number INTEGER NOT NULL, files_json TEXT NOT NULL, summary TEXT NOT NULL, model TEXT NOT NULL, quality_json TEXT, created_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS generation_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS generation_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, duration_ms INTEGER, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, model_calls INTEGER NOT NULL DEFAULT 0, repair_count INTEGER NOT NULL DEFAULT 0, current_stage TEXT NOT NULL DEFAULT 'requirements', active_step TEXT, step_started_at TEXT, version_id TEXT, error TEXT)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agent_events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL, sequence INTEGER NOT NULL, agent TEXT NOT NULL, phase TEXT NOT NULL, state TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, duration_ms INTEGER, model TEXT, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS generation_artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS model_attempts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL, agent TEXT NOT NULL, phase TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER NOT NULL, first_token_ms INTEGER, output_chars INTEGER NOT NULL DEFAULT 0, status_code INTEGER, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_manifests (project_id TEXT PRIMARY KEY, version_id TEXT NOT NULL, manifest_json TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, access_token_hash TEXT NOT NULL, refresh_token_hash TEXT NOT NULL, subject_id TEXT NOT NULL, subject_type TEXT NOT NULL, role TEXT NOT NULL, display_name TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_records (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, collection TEXT NOT NULL, owner_subject TEXT NOT NULL, data_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS runtime_evidence (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version_id TEXT, session_id TEXT, source TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, evidence_json TEXT NOT NULL, processed_at TEXT, created_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_backups (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, label TEXT NOT NULL, snapshot_json TEXT NOT NULL, record_count INTEGER NOT NULL, created_by TEXT NOT NULL, archive_key TEXT, archive_status TEXT NOT NULL DEFAULT 'not-configured', archive_bytes INTEGER, archive_error TEXT, expires_at TEXT, created_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS runner_jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS race_candidates (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL, stage TEXT NOT NULL, model TEXT NOT NULL, artifact TEXT NOT NULL, score INTEGER NOT NULL, selected INTEGER NOT NULL DEFAULT 0, output_chars INTEGER NOT NULL, created_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'demo', monthly_token_limit INTEGER NOT NULL DEFAULT 10000000, approval_required INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS organization_members (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, subject_id TEXT NOT NULL, email TEXT, role TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS project_approvals (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version_id TEXT NOT NULL, status TEXT NOT NULL, requested_by TEXT NOT NULL, reviewed_by TEXT, comment TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY, organization_id TEXT, project_id TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL, quantity INTEGER NOT NULL, unit TEXT NOT NULL, model TEXT, created_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS git_integrations (project_id TEXT PRIMARY KEY, provider TEXT NOT NULL, repository_owner TEXT NOT NULL, repository_name TEXT NOT NULL, default_branch TEXT NOT NULL DEFAULT 'main', installation_id TEXT, status TEXT NOT NULL, last_sync_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_database_resources (project_id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'cloudflare-d1', isolation TEXT NOT NULL DEFAULT 'physical-database', status TEXT NOT NULL DEFAULT 'pending', external_database_id TEXT, database_name TEXT NOT NULL, location_hint TEXT, schema_version INTEGER NOT NULL DEFAULT 0, desired_schema_version INTEGER NOT NULL DEFAULT 0, attempt_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, lease_expires_at TEXT, last_migration_at TEXT, last_backup_at TEXT, retention_until TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS provisioning_events (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, detail_json TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS backup_policies (project_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, interval_hours INTEGER NOT NULL DEFAULT 24, retention_days INTEGER NOT NULL DEFAULT 30, last_run_at TEXT, next_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS github_app_installations (installation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, account_login TEXT, account_type TEXT, permissions_json TEXT NOT NULL DEFAULT '{}', repository_selection TEXT, status TEXT NOT NULL DEFAULT 'active', suspended_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS oauth_states (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, provider TEXT NOT NULL, state_hash TEXT NOT NULL, payload_json TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS notification_deliveries (id TEXT PRIMARY KEY, organization_id TEXT, project_id TEXT, kind TEXT NOT NULL, channel TEXT NOT NULL, recipient TEXT NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, provider_message_id TEXT, error TEXT, payload_json TEXT NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_attempt_at TEXT, created_at TEXT NOT NULL, delivered_at TEXT)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS billing_accounts (organization_id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'stripe', customer_id TEXT, subscription_id TEXT, status TEXT NOT NULL DEFAULT 'configuration-required', plan TEXT NOT NULL DEFAULT 'demo', current_period_end TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY, organization_id TEXT, provider_event_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, processed_at TEXT)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS billing_invoices (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, provider_invoice_id TEXT NOT NULL, status TEXT NOT NULL, currency TEXT NOT NULL, amount_due INTEGER NOT NULL DEFAULT 0, amount_paid INTEGER NOT NULL DEFAULT 0, hosted_invoice_url TEXT, invoice_pdf TEXT, period_start TEXT, period_end TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS service_events (id TEXT PRIMARY KEY, project_id TEXT, organization_id TEXT, service TEXT NOT NULL, operation TEXT NOT NULL, level TEXT NOT NULL, duration_ms INTEGER, status_code INTEGER, message TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL)`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS operational_alerts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, project_id TEXT, organization_id TEXT, service TEXT NOT NULL, operation TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT, created_at TEXT NOT NULL, sent_at TEXT)`),
  ]);

  const info = await d1.prepare(`PRAGMA table_info(projects)`).all<{ name: string }>();
  const columns = new Set((info.results ?? []).map((column) => column.name));
  const additions = [
    ["owner_id", `ALTER TABLE projects ADD COLUMN owner_id TEXT`],
    ["organization_id", `ALTER TABLE projects ADD COLUMN organization_id TEXT`],
    ["published_version_id", `ALTER TABLE projects ADD COLUMN published_version_id TEXT`],
    ["generation_id", `ALTER TABLE projects ADD COLUMN generation_id TEXT`],
    ["generation_started_at", `ALTER TABLE projects ADD COLUMN generation_started_at TEXT`],
    ["intake_json", `ALTER TABLE projects ADD COLUMN intake_json TEXT`],
  ] as const;
  for (const [name, statement] of additions) {
    if (columns.has(name)) continue;
    try {
      await d1.prepare(statement).run();
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
    }
  }
  const versionInfo = await d1.prepare(`PRAGMA table_info(versions)`).all<{ name: string }>();
  const versionColumns = new Set((versionInfo.results ?? []).map((column) => column.name));
  if (!versionColumns.has("manifest_json")) {
    try {
      await d1.prepare(`ALTER TABLE versions ADD COLUMN manifest_json TEXT`).run();
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
    ["mode", `ALTER TABLE generation_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'standard'`],
  ] as const;
  for (const [name, statement] of runAdditions) {
    if (runColumns.has(name)) continue;
    try {
      await d1.prepare(statement).run();
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
    }
  }
  const organizationInfo = await d1.prepare(`PRAGMA table_info(organizations)`).all<{ name: string }>();
  if (!(organizationInfo.results ?? []).some((column) => column.name === "approval_required")) {
    try {
      await d1.prepare(`ALTER TABLE organizations ADD COLUMN approval_required INTEGER NOT NULL DEFAULT 0`).run();
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
    }
  }
  const evidenceInfo = await d1.prepare(`PRAGMA table_info(runtime_evidence)`).all<{ name: string }>();
  if (!(evidenceInfo.results ?? []).some((column) => column.name === "processed_at")) {
    try {
      await d1.prepare(`ALTER TABLE runtime_evidence ADD COLUMN processed_at TEXT`).run();
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
    }
  }
  const gitInfo = await d1.prepare(`PRAGMA table_info(git_integrations)`).all<{ name: string }>();
  if (!(gitInfo.results ?? []).some((column) => column.name === "installation_id")) {
    try {
      await d1.prepare(`ALTER TABLE git_integrations ADD COLUMN installation_id TEXT`).run();
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
    }
  }
  await ensureTableColumns(d1, "app_backups", [
    ["archive_key", `ALTER TABLE app_backups ADD COLUMN archive_key TEXT`],
    ["archive_status", `ALTER TABLE app_backups ADD COLUMN archive_status TEXT NOT NULL DEFAULT 'not-configured'`],
    ["archive_bytes", `ALTER TABLE app_backups ADD COLUMN archive_bytes INTEGER`],
    ["archive_error", `ALTER TABLE app_backups ADD COLUMN archive_error TEXT`],
    ["expires_at", `ALTER TABLE app_backups ADD COLUMN expires_at TEXT`],
  ]);
  await ensureTableColumns(d1, "app_database_resources", [
    ["desired_schema_version", `ALTER TABLE app_database_resources ADD COLUMN desired_schema_version INTEGER NOT NULL DEFAULT 0`],
    ["attempt_count", `ALTER TABLE app_database_resources ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`],
    ["next_retry_at", `ALTER TABLE app_database_resources ADD COLUMN next_retry_at TEXT`],
    ["lease_expires_at", `ALTER TABLE app_database_resources ADD COLUMN lease_expires_at TEXT`],
  ]);
  await ensureTableColumns(d1, "notification_deliveries", [
    ["payload_json", `ALTER TABLE notification_deliveries ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'`],
    ["attempts", `ALTER TABLE notification_deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`],
    ["next_attempt_at", `ALTER TABLE notification_deliveries ADD COLUMN next_attempt_at TEXT`],
    ["last_attempt_at", `ALTER TABLE notification_deliveries ADD COLUMN last_attempt_at TEXT`],
  ]);
  await d1.prepare(`UPDATE app_database_resources SET desired_schema_version=schema_version WHERE desired_schema_version=0 AND schema_version<>0`).run();
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
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_app_manifests_version ON app_manifests(version_id)`),
    d1.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_app_sessions_access_hash ON app_sessions(access_token_hash)`),
    d1.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_app_sessions_refresh_hash ON app_sessions(refresh_token_hash)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_app_sessions_project_subject ON app_sessions(project_id, subject_id)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_app_sessions_expires ON app_sessions(expires_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_app_records_project_collection_updated ON app_records(project_id, collection, updated_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_app_records_project_owner_collection ON app_records(project_id, owner_subject, collection)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_runtime_evidence_project_created ON runtime_evidence(project_id, created_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_app_backups_project_created ON app_backups(project_id, created_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_runner_jobs_project_created ON runner_jobs(project_id, created_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_race_candidates_run_stage ON race_candidates(run_id, stage)`),
    d1.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_owner ON organizations(owner_id)`),
    d1.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_organization_members_subject ON organization_members(organization_id, subject_id)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_organization_members_email ON organization_members(email)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_project_approvals_project_created ON project_approvals(project_id, created_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_usage_events_project_created ON usage_events(project_id, created_at)`),
    d1.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_app_database_resources_external ON app_database_resources(external_database_id)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_app_database_resources_status_updated ON app_database_resources(status, updated_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_provisioning_events_project_started ON provisioning_events(project_id, started_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_github_app_installations_owner ON github_app_installations(owner_id, updated_at)`),
    d1.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_states_hash ON oauth_states(state_hash)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states(expires_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_notification_deliveries_project_created ON notification_deliveries(project_id, created_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_notification_deliveries_retry ON notification_deliveries(status, next_attempt_at)`),
    d1.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_accounts_customer ON billing_accounts(customer_id)`),
    d1.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_events_provider_event ON billing_events(provider_event_id)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_billing_events_org_created ON billing_events(organization_id, created_at)`),
    d1.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_invoices_provider ON billing_invoices(provider_invoice_id)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_billing_invoices_org_created ON billing_invoices(organization_id, created_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_service_events_project_created ON service_events(project_id, created_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_service_events_level_created ON service_events(level, created_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_operational_alerts_retry ON operational_alerts(status, next_attempt_at)`),
    d1.prepare(`CREATE INDEX IF NOT EXISTS idx_operational_alerts_fingerprint_created ON operational_alerts(fingerprint, created_at)`),
  ]);
  await d1.prepare(`PRAGMA optimize`).run();
}

async function ensureTableColumns(d1: D1Database, table: string, additions: ReadonlyArray<readonly [string, string]>): Promise<void> {
  const info = await d1.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  const columns = new Set((info.results ?? []).map((column) => column.name));
  for (const [name, statement] of additions) {
    if (columns.has(name)) continue;
    try {
      await d1.prepare(statement).run();
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
    }
  }
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

async function ensurePersonalOrganization(ownerId: string): Promise<string> {
  const d1 = db();
  const existing = await d1.prepare(`SELECT id FROM organizations WHERE owner_id=? LIMIT 1`).bind(ownerId).first<{ id: string }>();
  const organizationId = existing?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  if (!existing) {
    await d1.prepare(`INSERT INTO organizations (id,owner_id,name,plan,monthly_token_limit,approval_required,created_at,updated_at) VALUES (?,?,?,'demo',10000000,0,?,?) ON CONFLICT(owner_id) DO UPDATE SET updated_at=excluded.updated_at`).bind(organizationId, ownerId, "个人工作区", now, now).run();
  }
  const organization = await d1.prepare(`SELECT id FROM organizations WHERE owner_id=? LIMIT 1`).bind(ownerId).first<{ id: string }>();
  const resolvedId = organization?.id ?? organizationId;
  await d1.prepare(`INSERT INTO organization_members (id,organization_id,subject_id,email,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,subject_id) DO UPDATE SET role='owner',status='active',updated_at=excluded.updated_at`).bind(crypto.randomUUID(), resolvedId, ownerId, null, "owner", "active", now, now).run();
  return resolvedId;
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
    manifest: json<AppManifest | null>(row.manifest_json, null),
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

function candidateFromRow(row: D1Row): RaceCandidate {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    projectId: String(row.project_id),
    stage: String(row.stage),
    model: String(row.model),
    score: Number(row.score),
    selected: Number(row.selected) === 1,
    outputChars: Number(row.output_chars),
    createdAt: String(row.created_at),
  };
}

function runFromRow(row: D1Row, events: GenerationEvent[], artifacts: GenerationArtifact[] = [], attempts: ModelAttemptRecord[] = [], candidates: RaceCandidate[] = []): GenerationRun {
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
    mode: String(row.mode ?? "standard") === "race" ? "race" : "standard",
    currentStage: (String(row.status) === "completed" ? "completed" : String(row.current_stage ?? "requirements")) as GenerationStage,
    events,
    artifacts,
    attempts,
    candidates,
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
  const versions = (result.results ?? []).map(versionFromRow);
  const manifestRow = await db().prepare(`SELECT manifest_json FROM app_manifests WHERE project_id=?`).bind(String(row.id)).first<D1Row>();
  const plan = json<AgentPlan | null>(row.plan_json, null);
  const currentVersion = versions.find((version) => version.id === String(row.current_version_id));
  let manifest = json<AppManifest | null>(manifestRow?.manifest_json, currentVersion?.manifest ?? null);
  if (!manifest && plan && currentVersion) {
    const now = new Date().toISOString();
    manifest = buildAppManifest({ projectId: String(row.id), versionId: currentVersion.id, plan, blueprint: defaultRuntimeBlueprint(String(row.prompt), plan), createdAt: currentVersion.createdAt });
    currentVersion.manifest = manifest;
    await db().batch([
      db().prepare(`UPDATE versions SET manifest_json=? WHERE id=? AND project_id=? AND manifest_json IS NULL`).bind(JSON.stringify(manifest), currentVersion.id, String(row.id)),
      db().prepare(`INSERT INTO app_manifests (project_id,version_id,manifest_json,schema_version,status,created_at,updated_at) VALUES (?,?,?,1,'active',?,?) ON CONFLICT(project_id) DO UPDATE SET version_id=excluded.version_id,manifest_json=excluded.manifest_json,status='active',updated_at=excluded.updated_at`).bind(String(row.id), currentVersion.id, JSON.stringify(manifest), now, now),
    ]);
  }
  let runs: GenerationRun[] = [];
  let messages: ProjectMessage[] = [];
  if (includeAudit) {
    const runRows = await db().prepare(`SELECT * FROM generation_runs WHERE project_id=? ORDER BY started_at DESC LIMIT 10`).bind(String(row.id)).all<D1Row>();
    const eventRows = await db().prepare(`SELECT * FROM agent_events WHERE project_id=? ORDER BY created_at DESC LIMIT 200`).bind(String(row.id)).all<D1Row>();
    const artifactRows = await db().prepare(`SELECT * FROM generation_artifacts WHERE project_id=? ORDER BY created_at ASC LIMIT 200`).bind(String(row.id)).all<D1Row>();
    const attemptRows = await db().prepare(`SELECT * FROM model_attempts WHERE project_id=? ORDER BY created_at DESC LIMIT 200`).bind(String(row.id)).all<D1Row>();
    const candidateRows = await db().prepare(`SELECT * FROM race_candidates WHERE project_id=? ORDER BY created_at ASC LIMIT 200`).bind(String(row.id)).all<D1Row>();
    const events = (eventRows.results ?? []).map(eventFromRow);
    const artifacts = (artifactRows.results ?? []).map(artifactFromRow);
    const attempts = (attemptRows.results ?? []).map(attemptFromRow);
    const candidates = (candidateRows.results ?? []).map(candidateFromRow);
    runs = (runRows.results ?? []).map((run) => runFromRow(
      run,
      events.filter((event) => event.runId === String(run.id)).sort((a, b) => a.sequence - b.sequence),
      artifacts.filter((artifact) => artifact.runId === String(run.id)),
      attempts.filter((attempt) => attempt.runId === String(run.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      candidates.filter((candidate) => candidate.runId === String(run.id)),
    ));
    const messageRows = await db().prepare(`SELECT * FROM (SELECT * FROM messages WHERE project_id=? ORDER BY created_at DESC LIMIT 100) ORDER BY created_at ASC`).bind(String(row.id)).all<D1Row>();
    messages = (messageRows.results ?? []).map(messageFromRow);
  }
  return {
    id: String(row.id),
    title: String(row.title),
    prompt: String(row.prompt),
    status: String(row.status) as Project["status"],
    plan,
    intake: json<ProjectIntake | null>(row.intake_json, null),
    manifest,
    files: json<GeneratedFiles>(row.files_json, starterFiles),
    currentVersionId: row.current_version_id ? String(row.current_version_id) : null,
    publishedVersionId: row.published_version_id ? String(row.published_version_id) : null,
    slug: row.slug ? String(row.slug) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    versions,
    runs,
    messages,
  };
}

export async function saveProjectIntake(id: string, ownerId: string, intake: ProjectIntake): Promise<Project | null> {
  await ensureSchema();
  const current = await db().prepare(`SELECT intake_json,status,current_version_id FROM projects WHERE id=? AND ${PROJECT_EDIT_ACCESS}`).bind(id, ownerId, ownerId).first<D1Row>();
  if (!current || String(current.status) !== "draft" || current.current_version_id) return null;
  if (current.intake_json) return getProject(id, ownerId);
  const now = new Date().toISOString();
  const assistantSummary = `${intake.summary}\n\n${intake.question}`;
  await db().batch([
    db().prepare(`UPDATE projects SET intake_json=?,updated_at=? WHERE id=? AND ${PROJECT_EDIT_ACCESS} AND status='draft' AND current_version_id IS NULL AND intake_json IS NULL`).bind(JSON.stringify(intake), now, id, ownerId, ownerId),
    db().prepare(`INSERT INTO messages (id,project_id,role,content,created_at) SELECT ?,?,'assistant',?,? WHERE EXISTS (SELECT 1 FROM projects WHERE id=? AND intake_json IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM messages WHERE project_id=? AND role='assistant')`).bind(crypto.randomUUID(), id, assistantSummary, now, id, id),
  ]);
  return getProject(id, ownerId);
}

export async function adoptVisitorProjects(visitorOwnerId: string, accountOwnerId: string): Promise<number> {
  if (!visitorOwnerId || !accountOwnerId || visitorOwnerId === accountOwnerId) return 0;
  await ensureSchema();
  const organizationId = await ensurePersonalOrganization(accountOwnerId);
  const result = await db().prepare(`UPDATE projects SET owner_id=?,organization_id=?,updated_at=? WHERE owner_id=?`).bind(accountOwnerId, organizationId, new Date().toISOString(), visitorOwnerId).run();
  return Number(result.meta.changes ?? 0);
}

export async function createProject(prompt: string, ownerId: string): Promise<Project> {
  await ensureSchema();
  const organizationId = await ensurePersonalOrganization(ownerId);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const title = prompt.slice(0, 38) || "未命名应用";
  await db().batch([
    db().prepare(`INSERT INTO projects (id,owner_id,organization_id,title,prompt,status,files_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(id, ownerId, organizationId, title, prompt, "draft", JSON.stringify(starterFiles), now, now),
    db().prepare(`INSERT INTO messages (id,project_id,role,content,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), id, "user", prompt, now),
  ]);
  return (await getProject(id, ownerId))!;
}

export async function getProject(id: string, ownerId: string): Promise<Project | null> {
  await ensureSchema();
  await db().prepare(`UPDATE projects SET owner_id=? WHERE id=? AND owner_id IS NULL`).bind(ownerId, id).run();
  const organizationId = await ensurePersonalOrganization(ownerId);
  await db().prepare(`UPDATE projects SET organization_id=? WHERE id=? AND owner_id=? AND organization_id IS NULL`).bind(organizationId, id, ownerId).run();
  let row = await db().prepare(`SELECT * FROM projects WHERE id=? AND ${PROJECT_READ_ACCESS}`).bind(id, ownerId, ownerId).first<D1Row>();
  if (isStaleGeneration(row)) {
    await recoverStaleGenerations(ownerId, id);
    row = await db().prepare(`SELECT * FROM projects WHERE id=? AND ${PROJECT_READ_ACCESS}`).bind(id, ownerId, ownerId).first<D1Row>();
  }
  return row ? projectFromRow(row) : null;
}

export async function listProjects(ownerId: string): Promise<Project[]> {
  await ensureSchema();
  let rows = await db().prepare(`SELECT * FROM projects WHERE ${PROJECT_READ_ACCESS} ORDER BY updated_at DESC LIMIT 20`).bind(ownerId, ownerId).all<D1Row>();
  if ((rows.results ?? []).some(isStaleGeneration)) {
    await recoverStaleGenerations(ownerId);
    rows = await db().prepare(`SELECT * FROM projects WHERE ${PROJECT_READ_ACCESS} ORDER BY updated_at DESC LIMIT 20`).bind(ownerId, ownerId).all<D1Row>();
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

export async function beginGeneration(id: string, ownerId: string, prompt: string, model: string, mode: "standard" | "race" = "standard"): Promise<string | null> {
  await ensureSchema();
  const generationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - GENERATION_LEASE_TTL_MS).toISOString();
  const locked = await db().prepare(`UPDATE projects SET status='generating', prompt=?, generation_id=?, generation_started_at=?, updated_at=? WHERE id=? AND ${PROJECT_EDIT_ACCESS} AND (status!='generating' OR generation_started_at IS NULL OR generation_started_at<?) RETURNING id`).bind(prompt, generationId, now, now, id, ownerId, ownerId, staleBefore).first<{ id: string }>();
  if (!locked) return null;
  try {
    await db().batch([
      db().prepare(`UPDATE generation_runs SET status='failed', completed_at=?, duration_ms=MAX(0,CAST((julianday(?) - julianday(started_at))*86400000 AS INTEGER)), error='生成租约过期，已由新任务回收' WHERE project_id=? AND status='running'`).bind(now, now, id),
      db().prepare(`INSERT INTO generation_runs (id,project_id,prompt,status,model,mode,started_at) VALUES (?,?,?,?,?,?,?)`).bind(generationId, id, prompt, "running", model, mode, now),
      db().prepare(`INSERT INTO messages (id,project_id,role,content,created_at) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM messages WHERE id=(SELECT id FROM messages WHERE project_id=? ORDER BY created_at DESC LIMIT 1) AND role='user' AND content=?)`).bind(crypto.randomUUID(), id, "user", prompt, now, id, prompt),
    ]);
  } catch (error) {
    await db().prepare(`UPDATE projects SET status=CASE WHEN current_version_id IS NULL THEN 'draft' ELSE 'ready' END, generation_id=NULL, generation_started_at=NULL, updated_at=? WHERE id=? AND ${PROJECT_EDIT_ACCESS} AND generation_id=?`).bind(new Date().toISOString(), id, ownerId, ownerId, generationId).run().catch(() => undefined);
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
    db().prepare(`UPDATE generation_runs SET status='failed', completed_at=?, duration_ms=MAX(0,CAST((julianday(?) - julianday(started_at))*86400000 AS INTEGER)), error=? WHERE id IN (SELECT p.generation_id FROM projects p WHERE ${PROJECT_READ_ACCESS_P} AND (? IS NULL OR p.id=?) AND p.status='generating' AND p.generation_id IS NOT NULL AND p.generation_started_at<?) AND status='running'`).bind(nowIso, nowIso, reason, ownerId, ownerId, scopedProjectId, scopedProjectId, staleBefore),
    db().prepare(`UPDATE projects SET status=CASE WHEN current_version_id IS NULL THEN 'error' ELSE 'ready' END, generation_id=NULL, generation_started_at=NULL, updated_at=? WHERE ${PROJECT_READ_ACCESS} AND (? IS NULL OR id=?) AND status='generating' AND generation_started_at<?`).bind(nowIso, ownerId, ownerId, scopedProjectId, scopedProjectId, staleBefore),
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
  // A code/review step may legitimately run for about 245 seconds. Reclaiming
  // after 70 seconds allowed a reconnecting browser to start the same model
  // stage concurrently. Keep the lease longer than the route deadline; the
  // normal finally path still releases it immediately on completion.
  const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
  const acquired = await db().prepare(`UPDATE generation_runs SET active_step=?,step_started_at=?,error=NULL WHERE id=? AND project_id=? AND status='running' AND (active_step IS NULL OR step_started_at IS NULL OR step_started_at<?) AND EXISTS (SELECT 1 FROM projects p WHERE p.id=? AND ${PROJECT_EDIT_ACCESS_P} AND p.generation_id=? AND p.status='generating') RETURNING id`).bind(token, now, runId, projectId, staleBefore, projectId, ownerId, ownerId, runId).first<{ id: string }>();
  if (!acquired) return null;
  await db().prepare(`UPDATE projects SET generation_started_at=?,updated_at=? WHERE id=? AND ${PROJECT_EDIT_ACCESS} AND generation_id=?`).bind(now, now, projectId, ownerId, ownerId, runId).run();
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
  const now = Date.now();
  await db().batch(attempts.map((item, index) => db().prepare(`INSERT INTO model_attempts (id,run_id,project_id,agent,phase,model,status,duration_ms,first_token_ms,output_chars,status_code,prompt_tokens,completion_tokens,total_tokens,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), runId, projectId, agent, phase, item.model, item.status, item.durationMs, item.firstTokenMs, item.outputChars, item.statusCode, item.usage.promptTokens, item.usage.completionTokens, item.usage.totalTokens, item.error?.slice(0, 600) ?? null, new Date(now + index).toISOString())));
  const usage = attempts.reduce((total, item) => ({ promptTokens: total.promptTokens + item.usage.promptTokens, completionTokens: total.completionTokens + item.usage.completionTokens, totalTokens: total.totalTokens + item.usage.totalTokens }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  const models = [...new Set([active.model, ...attempts.map((item) => item.model)].flatMap((value) => value.split(" → ")).filter(Boolean))];
  await db().prepare(`UPDATE generation_runs SET prompt_tokens=prompt_tokens+?,completion_tokens=completion_tokens+?,total_tokens=total_tokens+?,model_calls=model_calls+?,model=? WHERE id=? AND project_id=? AND status='running'`).bind(usage.promptTokens, usage.completionTokens, usage.totalTokens, attempts.length, models.join(" → "), runId, projectId).run();
}

export async function recordRaceCandidates(runId: string, projectId: string, stage: string, candidates: Array<{ model: string; artifact: string; score: number; selected: boolean }>): Promise<RaceCandidate[]> {
  if (candidates.length === 0) return [];
  await ensureSchema();
  const active = await db().prepare(`SELECT id FROM generation_runs WHERE id=? AND project_id=? AND status='running'`).bind(runId, projectId).first<{ id: string }>();
  if (!active) throw new Error("生成任务已结束，拒绝迟到的竞速候选");
  const now = new Date().toISOString();
  await db().prepare(`DELETE FROM race_candidates WHERE run_id=? AND project_id=? AND stage=?`).bind(runId, projectId, stage).run();
  const rows = candidates.slice(0, 4).map((candidate) => ({
    id: crypto.randomUUID(),
    runId,
    projectId,
    stage,
    model: candidate.model.slice(0, 120),
    artifact: candidate.artifact.slice(0, 120_000),
    score: Math.max(0, Math.min(100, Math.round(candidate.score))),
    selected: candidate.selected,
    outputChars: candidate.artifact.length,
    createdAt: now,
  }));
  await db().batch(rows.map((row) => db().prepare(`INSERT INTO race_candidates (id,run_id,project_id,stage,model,artifact,score,selected,output_chars,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(row.id, row.runId, row.projectId, row.stage, row.model, row.artifact, row.score, row.selected ? 1 : 0, row.outputChars, row.createdAt)));
  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    projectId: row.projectId,
    stage: row.stage,
    model: row.model,
    score: row.score,
    selected: row.selected,
    outputChars: row.outputChars,
    createdAt: row.createdAt,
  }));
}

export async function incrementGenerationRepair(runId: string, projectId: string): Promise<void> {
  await ensureSchema();
  await db().prepare(`UPDATE generation_runs SET repair_count=repair_count+1 WHERE id=? AND project_id=? AND status='running'`).bind(runId, projectId).run();
}

export async function saveGeneration(id: string, ownerId: string, generationId: string, plan: AgentPlan, files: GeneratedFiles, summary: string, model: string, quality: AppQualityReport, metrics: GenerationMetrics, blueprint?: AppRuntimeBlueprint): Promise<Project> {
  await ensureSchema();
  const count = await db().prepare(`SELECT COUNT(*) AS total FROM versions WHERE project_id=?`).bind(id).first<{ total: number }>();
  const versionNumber = Number(count?.total ?? 0) + 1;
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const runtime = env as unknown as Record<string, unknown>;
  const githubAppReady = Boolean(runtime.GITHUB_APP_ID && runtime.GITHUB_APP_SLUG && runtime.GITHUB_APP_CLIENT_ID && runtime.GITHUB_APP_CLIENT_SECRET && runtime.GITHUB_APP_PRIVATE_KEY);
  const legacyPatReady = String(runtime.NUCLEUS_ALLOW_LEGACY_GITHUB_PAT ?? "").toLowerCase() === "true" && Boolean(runtime.GITHUB_AUTOMATION_TOKEN);
  const databaseProvisionerReady = Boolean(runtime.CLOUDFLARE_ACCOUNT_ID && runtime.CLOUDFLARE_D1_API_TOKEN);
  const physicalDatabaseName = `nucleus-${id.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || versionId.slice(0, 12)}`.slice(0, 62);
  const manifest = buildAppManifest({
    projectId: id,
    versionId,
    plan,
    blueprint: blueprint ?? defaultRuntimeBlueprint(plan.summary, plan),
    createdAt: now,
    browserRunnerReady: Boolean(runtime.NUCLEUS_RUNNER_CALLBACK_TOKEN && runtime.GITHUB_RUNNER_REPOSITORY && (legacyPatReady || (githubAppReady && runtime.GITHUB_RUNNER_INSTALLATION_ID))),
    containerRunnerReady: Boolean(runtime.NUCLEUS_CONTAINER_RUNNER_URL && runtime.NUCLEUS_CONTAINER_RUNNER_TOKEN),
    gitAutomationReady: Boolean(legacyPatReady || githubAppReady),
    databaseProvisionerReady,
    emailReady: Boolean(runtime.RESEND_API_KEY && runtime.NUCLEUS_EMAIL_FROM),
    billingReady: Boolean(runtime.STRIPE_SECRET_KEY && runtime.STRIPE_WEBHOOK_SECRET),
    observabilityReady: Boolean(runtime.NUCLEUS_ALERT_WEBHOOK_URL || runtime.SENTRY_DSN),
  });
  const desiredDatabaseSchemaVersion = await databaseSchemaRevision(manifest);
  const existingDatabaseResource = await db().prepare(`SELECT status,external_database_id,schema_version FROM app_database_resources WHERE project_id=?`).bind(id).first<D1Row>();
  if (databaseProvisionerReady && existingDatabaseResource?.status === "ready" && existingDatabaseResource.external_database_id && Number(existingDatabaseResource.schema_version) === desiredDatabaseSchemaVersion) {
    manifest.capabilities.physicalDatabase = "ready";
    manifest.database.provider = "cloudflare-d1";
    manifest.database.isolation = "physical-database";
  }
  const results = await db().batch([
    db().prepare(`INSERT INTO versions (id,project_id,version_number,files_json,summary,model,quality_json,manifest_json,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM projects p WHERE p.id=? AND ${PROJECT_EDIT_ACCESS_P} AND p.generation_id=?) AND EXISTS (SELECT 1 FROM generation_runs WHERE id=? AND project_id=? AND status='running')`).bind(versionId, id, versionNumber, JSON.stringify(files), summary, model, JSON.stringify(quality), JSON.stringify(manifest), now, id, ownerId, ownerId, generationId, generationId, id),
    db().prepare(`INSERT INTO messages (id,project_id,role,content,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM projects p WHERE p.id=? AND ${PROJECT_EDIT_ACCESS_P} AND p.generation_id=?) AND EXISTS (SELECT 1 FROM generation_runs WHERE id=? AND project_id=? AND status='running')`).bind(crypto.randomUUID(), id, "assistant", summary, now, id, ownerId, ownerId, generationId, generationId, id),
    db().prepare(`UPDATE projects SET title=?, status='ready', plan_json=?, files_json=?, current_version_id=?, generation_id=NULL, generation_started_at=NULL, updated_at=? WHERE id=? AND ${PROJECT_EDIT_ACCESS} AND generation_id=? AND EXISTS (SELECT 1 FROM generation_runs WHERE id=? AND project_id=? AND status='running')`).bind(plan.appName, JSON.stringify(plan), JSON.stringify(files), versionId, now, id, ownerId, ownerId, generationId, generationId, id),
    db().prepare(`UPDATE generation_runs SET status='completed', current_stage='completed', active_step=NULL, step_started_at=NULL, completed_at=?, duration_ms=?, prompt_tokens=?, completion_tokens=?, total_tokens=?, model_calls=?, repair_count=?, model=?, version_id=?, error=NULL WHERE id=? AND project_id=? AND status='running'`).bind(now, metrics.durationMs, metrics.usage.promptTokens, metrics.usage.completionTokens, metrics.usage.totalTokens, metrics.modelCalls, metrics.repairCount, metrics.model, versionId, generationId, id),
    db().prepare(`INSERT INTO app_manifests (project_id,version_id,manifest_json,schema_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET version_id=excluded.version_id,manifest_json=excluded.manifest_json,schema_version=excluded.schema_version,status='active',updated_at=excluded.updated_at`).bind(id, versionId, JSON.stringify(manifest), manifest.schemaVersion, "active", now, now),
    db().prepare(`INSERT INTO app_database_resources (project_id,provider,isolation,status,external_database_id,database_name,location_hint,schema_version,desired_schema_version,attempt_count,next_retry_at,lease_expires_at,last_migration_at,last_backup_at,retention_until,last_error,created_at,updated_at) VALUES (?,'cloudflare-d1','physical-database',?,NULL,?,?,0,?,0,NULL,NULL,NULL,NULL,NULL,?, ?,?) ON CONFLICT(project_id) DO UPDATE SET status=CASE WHEN app_database_resources.status IN ('deletion-scheduled','deleted') THEN app_database_resources.status WHEN app_database_resources.status='ready' AND app_database_resources.schema_version=excluded.desired_schema_version THEN 'ready' ELSE excluded.status END,database_name=excluded.database_name,location_hint=excluded.location_hint,desired_schema_version=excluded.desired_schema_version,next_retry_at=CASE WHEN app_database_resources.schema_version=excluded.desired_schema_version THEN app_database_resources.next_retry_at ELSE NULL END,last_error=CASE WHEN app_database_resources.status='ready' AND app_database_resources.schema_version=excluded.desired_schema_version THEN NULL ELSE excluded.last_error END,updated_at=excluded.updated_at`).bind(id, databaseProvisionerReady ? "pending" : "configuration-required", physicalDatabaseName, typeof runtime.NUCLEUS_D1_LOCATION_HINT === "string" ? runtime.NUCLEUS_D1_LOCATION_HINT : null, desiredDatabaseSchemaVersion, databaseProvisionerReady ? null : "缺少 Cloudflare D1 Provisioner 凭据", now, now),
    db().prepare(`INSERT INTO backup_policies (project_id,enabled,interval_hours,retention_days,last_run_at,next_run_at,created_at,updated_at) VALUES (?,1,24,30,NULL,?,?,?) ON CONFLICT(project_id) DO NOTHING`).bind(id, new Date(Date.now() + 86_400_000).toISOString(), now, now),
    db().prepare(`INSERT INTO usage_events (id,organization_id,project_id,run_id,kind,quantity,unit,model,created_at) SELECT ?,organization_id,?,?,?,?,?,?,? FROM projects WHERE id=?`).bind(crypto.randomUUID(), id, generationId, "model_tokens", metrics.usage.totalTokens, "tokens", metrics.model, now, id),
    db().prepare(`INSERT INTO usage_events (id,organization_id,project_id,run_id,kind,quantity,unit,model,created_at) SELECT ?,organization_id,?,?,?,?,?,?,? FROM projects WHERE id=?`).bind(crypto.randomUUID(), id, generationId, "model_calls", metrics.modelCalls, "calls", metrics.model, now, id),
  ]);
  if (Number(results[2]?.meta.changes ?? 0) !== 1 || Number(results[3]?.meta.changes ?? 0) !== 1) throw new Error("生成任务已过期，请重新开始");
  return (await getProject(id, ownerId))!;
}

export async function markError(id: string, ownerId: string, generationId: string, error: string, metrics: GenerationMetrics): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  await db().batch([
    db().prepare(`UPDATE projects SET status='error', generation_id=NULL, generation_started_at=NULL, updated_at=? WHERE id=? AND ${PROJECT_EDIT_ACCESS} AND generation_id=?`).bind(now, id, ownerId, ownerId, generationId),
    db().prepare(`UPDATE generation_runs SET status='failed', active_step=NULL, step_started_at=NULL, completed_at=?, duration_ms=?, prompt_tokens=?, completion_tokens=?, total_tokens=?, model_calls=?, repair_count=?, model=?, error=? WHERE id=? AND project_id=? AND status='running'`).bind(now, metrics.durationMs, metrics.usage.promptTokens, metrics.usage.completionTokens, metrics.usage.totalTokens, metrics.modelCalls, metrics.repairCount, metrics.model, error.slice(0, 600), generationId, id),
  ]);
}

export async function releaseGeneration(id: string, ownerId: string, generationId: string, status: "draft" | "ready", reason = "生成任务已释放", runStatus: "rejected" | "cancelled" = "rejected"): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  await db().batch([
    db().prepare(`UPDATE projects SET status=?, generation_id=NULL, generation_started_at=NULL, updated_at=? WHERE id=? AND ${PROJECT_EDIT_ACCESS} AND generation_id=?`).bind(status, now, id, ownerId, ownerId, generationId),
    db().prepare(`UPDATE generation_runs SET status=?, active_step=NULL, step_started_at=NULL, completed_at=?, duration_ms=MAX(0,CAST((julianday(?) - julianday(started_at))*86400000 AS INTEGER)), error=? WHERE id=? AND project_id=? AND status='running'`).bind(runStatus, now, now, reason.slice(0, 600), generationId, id),
  ]);
}

export async function cancelGeneration(id: string, ownerId: string): Promise<string | null> {
  await ensureSchema();
  const active = await db().prepare(`SELECT generation_id,generation_started_at FROM projects WHERE id=? AND ${PROJECT_EDIT_ACCESS} AND status='generating' AND generation_id IS NOT NULL`).bind(id, ownerId, ownerId).first<{ generation_id: string; generation_started_at: string | null }>();
  if (!active?.generation_id) return null;
  const now = new Date();
  const durationMs = active.generation_started_at ? Math.max(0, now.getTime() - new Date(active.generation_started_at).getTime()) : null;
  const results = await db().batch([
    db().prepare(`UPDATE projects SET status=CASE WHEN current_version_id IS NULL THEN 'draft' ELSE 'ready' END, generation_id=NULL, generation_started_at=NULL, updated_at=? WHERE id=? AND ${PROJECT_EDIT_ACCESS} AND generation_id=?`).bind(now.toISOString(), id, ownerId, ownerId, active.generation_id),
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
  const now = new Date().toISOString();
  const statements = [
    db().prepare(`UPDATE projects SET files_json=?, current_version_id=?, status='ready', updated_at=? WHERE id=? AND ${PROJECT_EDIT_ACCESS}`).bind(String(version.files_json), versionId, now, projectId, ownerId, ownerId),
  ];
  if (version.manifest_json) {
    statements.push(db().prepare(`INSERT INTO app_manifests (project_id,version_id,manifest_json,schema_version,status,created_at,updated_at) VALUES (?,?,?,1,'active',?,?) ON CONFLICT(project_id) DO UPDATE SET version_id=excluded.version_id,manifest_json=excluded.manifest_json,status='active',updated_at=excluded.updated_at`).bind(projectId, versionId, String(version.manifest_json), now, now));
  }
  await db().batch(statements);
  return getProject(projectId, ownerId);
}

export async function publishProject(id: string, ownerId: string): Promise<Project | null> {
  await ensureSchema();
  const current = await getProject(id, ownerId);
  if (!current?.currentVersionId || current.status === "generating") return null;
  const slug = current.slug ?? `${current.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 26) || "app"}-${id.slice(0, 6)}`;
  await db().prepare(`UPDATE projects SET slug=?, published_version_id=?, updated_at=? WHERE id=? AND ${PROJECT_EDIT_ACCESS}`).bind(slug, current.currentVersionId, new Date().toISOString(), id, ownerId, ownerId).run();
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

export async function consumeGenerationQuota(identifier: string, limit = 100): Promise<boolean> {
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
