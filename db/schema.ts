import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id"),
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
