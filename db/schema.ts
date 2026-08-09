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
