import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  status: text("status").notNull(),
  planJson: text("plan_json"),
  filesJson: text("files_json").notNull(),
  currentVersionId: text("current_version_id"),
  slug: text("slug").unique(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const versions = sqliteTable("versions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  filesJson: text("files_json").notNull(),
  summary: text("summary").notNull(),
  model: text("model").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_versions_project_created").on(table.projectId, table.createdAt)]);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_messages_project_created").on(table.projectId, table.createdAt)]);
