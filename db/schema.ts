import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id"),
  organizationId: text("organization_id"),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  status: text("status").notNull(),
  planJson: text("plan_json"),
  filesJson: text("files_json").notNull(),
  currentVersionId: text("current_version_id"),
  publishedVersionId: text("published_version_id"),
  generationId: text("generation_id"),
  generationStartedAt: text("generation_started_at"),
  slug: text("slug").unique(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_projects_owner_updated").on(table.ownerId, table.updatedAt)]);

export const versions = sqliteTable("versions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  filesJson: text("files_json").notNull(),
  summary: text("summary").notNull(),
  model: text("model").notNull(),
  qualityJson: text("quality_json"),
  manifestJson: text("manifest_json"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_versions_project_number").on(table.projectId, table.versionNumber),
  index("idx_versions_project_created").on(table.projectId, table.createdAt),
]);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_messages_project_created").on(table.projectId, table.createdAt)]);

export const generationLimits = sqliteTable("generation_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  expiresAt: text("expires_at").notNull(),
}, (table) => [index("idx_generation_limits_expires").on(table.expiresAt)]);

export const generationRuns = sqliteTable("generation_runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  prompt: text("prompt").notNull(),
  status: text("status").notNull(),
  model: text("model").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  durationMs: integer("duration_ms"),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  modelCalls: integer("model_calls").notNull().default(0),
  repairCount: integer("repair_count").notNull().default(0),
  mode: text("mode").notNull().default("standard"),
  currentStage: text("current_stage").notNull().default("requirements"),
  activeStep: text("active_step"),
  stepStartedAt: text("step_started_at"),
  versionId: text("version_id"),
  error: text("error"),
}, (table) => [index("idx_generation_runs_project_started").on(table.projectId, table.startedAt)]);

export const agentEvents = sqliteTable("agent_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  projectId: text("project_id").notNull(),
  sequence: integer("sequence").notNull(),
  agent: text("agent").notNull(),
  phase: text("phase").notNull(),
  state: text("state").notNull(),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  durationMs: integer("duration_ms"),
  model: text("model"),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_agent_events_run_sequence").on(table.runId, table.sequence),
  index("idx_agent_events_project_created").on(table.projectId, table.createdAt),
]);

export const generationArtifacts = sqliteTable("generation_artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  projectId: text("project_id").notNull(),
  agent: text("agent").notNull(),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("uq_generation_artifacts_run_kind").on(table.runId, table.kind),
  index("idx_generation_artifacts_project_run").on(table.projectId, table.runId),
]);

export const modelAttempts = sqliteTable("model_attempts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  projectId: text("project_id").notNull(),
  agent: text("agent").notNull(),
  phase: text("phase").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull(),
  durationMs: integer("duration_ms").notNull(),
  firstTokenMs: integer("first_token_ms"),
  outputChars: integer("output_chars").notNull().default(0),
  statusCode: integer("status_code"),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  error: text("error"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_model_attempts_run_created").on(table.runId, table.createdAt),
  index("idx_model_attempts_project_created").on(table.projectId, table.createdAt),
]);

export const appManifests = sqliteTable("app_manifests", {
  projectId: text("project_id").primaryKey(),
  versionId: text("version_id").notNull(),
  manifestJson: text("manifest_json").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_app_manifests_version").on(table.versionId)]);

export const appSessions = sqliteTable("app_sessions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  accessTokenHash: text("access_token_hash").notNull(),
  refreshTokenHash: text("refresh_token_hash").notNull(),
  subjectId: text("subject_id").notNull(),
  subjectType: text("subject_type").notNull(),
  role: text("role").notNull(),
  displayName: text("display_name"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, (table) => [
  uniqueIndex("uq_app_sessions_access_hash").on(table.accessTokenHash),
  uniqueIndex("uq_app_sessions_refresh_hash").on(table.refreshTokenHash),
  index("idx_app_sessions_project_subject").on(table.projectId, table.subjectId),
  index("idx_app_sessions_expires").on(table.expiresAt),
]);

export const appRecords = sqliteTable("app_records", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  collection: text("collection").notNull(),
  ownerSubject: text("owner_subject").notNull(),
  dataJson: text("data_json").notNull(),
  revision: integer("revision").notNull().default(1),
  deletedAt: text("deleted_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_app_records_project_collection_updated").on(table.projectId, table.collection, table.updatedAt),
  index("idx_app_records_project_owner_collection").on(table.projectId, table.ownerSubject, table.collection),
]);

export const runtimeEvidence = sqliteTable("runtime_evidence", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  versionId: text("version_id"),
  sessionId: text("session_id"),
  source: text("source").notNull(),
  level: text("level").notNull(),
  message: text("message").notNull(),
  evidenceJson: text("evidence_json").notNull(),
  processedAt: text("processed_at"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_runtime_evidence_project_created").on(table.projectId, table.createdAt)]);

export const appBackups = sqliteTable("app_backups", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  label: text("label").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  recordCount: integer("record_count").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_app_backups_project_created").on(table.projectId, table.createdAt)]);

export const runnerJobs = sqliteTable("runner_jobs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  versionId: text("version_id"),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  provider: text("provider").notNull(),
  requestJson: text("request_json").notNull(),
  resultJson: text("result_json"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
}, (table) => [index("idx_runner_jobs_project_created").on(table.projectId, table.createdAt)]);

export const raceCandidates = sqliteTable("race_candidates", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  projectId: text("project_id").notNull(),
  stage: text("stage").notNull(),
  model: text("model").notNull(),
  artifact: text("artifact").notNull(),
  score: integer("score").notNull(),
  selected: integer("selected", { mode: "boolean" }).notNull().default(false),
  outputChars: integer("output_chars").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_race_candidates_run_stage").on(table.runId, table.stage)]);

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("demo"),
  monthlyTokenLimit: integer("monthly_token_limit").notNull().default(2_000_000),
  approvalRequired: integer("approval_required", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("uq_organizations_owner").on(table.ownerId)]);

export const organizationMembers = sqliteTable("organization_members", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  subjectId: text("subject_id").notNull(),
  email: text("email"),
  role: text("role").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("uq_organization_members_subject").on(table.organizationId, table.subjectId),
  index("idx_organization_members_email").on(table.email),
]);

export const projectApprovals = sqliteTable("project_approvals", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  versionId: text("version_id").notNull(),
  status: text("status").notNull(),
  requestedBy: text("requested_by").notNull(),
  reviewedBy: text("reviewed_by"),
  comment: text("comment"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_project_approvals_project_created").on(table.projectId, table.createdAt)]);

export const usageEvents = sqliteTable("usage_events", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id"),
  projectId: text("project_id").notNull(),
  runId: text("run_id"),
  kind: text("kind").notNull(),
  quantity: integer("quantity").notNull(),
  unit: text("unit").notNull(),
  model: text("model"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_usage_events_project_created").on(table.projectId, table.createdAt)]);

export const gitIntegrations = sqliteTable("git_integrations", {
  projectId: text("project_id").primaryKey(),
  provider: text("provider").notNull(),
  repositoryOwner: text("repository_owner").notNull(),
  repositoryName: text("repository_name").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  status: text("status").notNull(),
  lastSyncJson: text("last_sync_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
