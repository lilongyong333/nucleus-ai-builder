import type {
  AgentPlan,
  AppBackendFunction,
  AppCollectionField,
  AppCollectionSchema,
  AppManifest,
  AppRuntimeBlueprint,
  RuntimeFieldType,
} from "./types";

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const FIELD_TYPES = new Set<RuntimeFieldType>(["string", "number", "boolean", "date", "json"]);
const ACCESS_MODES = new Set<AppCollectionSchema["access"]>(["owner", "public-read", "public-write"]);

export function defaultRuntimeBlueprint(prompt: string, plan: AgentPlan): AppRuntimeBlueprint {
  const source = `${prompt}\n${plan.archetype ?? ""}\n${plan.features.join("\n")}`.toLowerCase();
  const authMode: AppRuntimeBlueprint["authMode"] = /登录|注册|账号|账户|用户中心|团队|组织|login|sign[ -]?in|account|team/u.test(source)
    ? "mixed"
    : "anonymous";

  let collections: AppCollectionSchema[];
  if (/贪吃蛇|游戏|排行榜|分数|score|leaderboard|game/u.test(source)) {
    collections = [{
      name: "scores",
      label: "成绩",
      access: "public-read",
      fields: [
        field("playerName", "string", true, 80),
        field("score", "number", true),
        field("durationSeconds", "number", false),
        field("metadata", "json", false),
      ],
    }];
  } else if (/任务|待办|清单|看板|todo|task|kanban/u.test(source)) {
    collections = [{
      name: "tasks",
      label: "任务",
      access: "owner",
      fields: [
        field("title", "string", true, 240),
        field("completed", "boolean", true, undefined, false),
        field("priority", "string", false, 24),
        field("dueAt", "date", false),
      ],
    }];
  } else if (/聊天|消息|评论|反馈|chat|message|comment|feedback/u.test(source)) {
    collections = [{
      name: "messages",
      label: "消息",
      access: "public-write",
      fields: [
        field("author", "string", false, 80),
        field("content", "string", true, 4_000),
        field("metadata", "json", false),
      ],
    }];
  } else {
    collections = [{
      name: "items",
      label: "应用数据",
      access: "owner",
      fields: [
        field("title", "string", true, 240),
        field("status", "string", false, 40),
        field("details", "json", false),
      ],
    }];
  }

  return {
    collections,
    authMode,
    backendFunctions: defaultBackendFunctions(collections),
    dependencies: { npm: [], pip: [], system: [], containers: [] },
  };
}

export function normalizeRuntimeBlueprint(value: unknown, prompt: string, plan: AgentPlan): AppRuntimeBlueprint {
  const fallback = defaultRuntimeBlueprint(prompt, plan);
  const raw = objectValue(value);
  const collections = arrayValue(raw.collections)
    .map((item) => normalizeCollection(item))
    .filter((item): item is AppCollectionSchema => item !== null)
    .slice(0, 12);
  const selectedCollections = collections.length > 0 ? collections : fallback.collections;
  const mode = raw.authMode;
  const authMode = mode === "account" || mode === "mixed" || mode === "anonymous" ? mode : fallback.authMode;
  const backendFunctions = arrayValue(raw.backendFunctions)
    .map((item) => normalizeFunction(item))
    .filter((item): item is AppBackendFunction => item !== null)
    .slice(0, 16);
  const dependencies = objectValue(raw.dependencies);
  return {
    collections: selectedCollections,
    authMode,
    backendFunctions: mergeFunctions(defaultBackendFunctions(selectedCollections), backendFunctions),
    dependencies: {
      npm: safeStringArray(dependencies.npm, 20),
      pip: safeStringArray(dependencies.pip, 20),
      system: safeStringArray(dependencies.system, 12),
      containers: safeStringArray(dependencies.containers, 8),
    },
  };
}

export function buildAppManifest(input: {
  projectId: string;
  versionId: string;
  plan: AgentPlan;
  blueprint: AppRuntimeBlueprint;
  createdAt?: string;
  browserRunnerReady?: boolean;
  containerRunnerReady?: boolean;
  gitAutomationReady?: boolean;
}): AppManifest {
  const requiresExternalRunner = input.blueprint.dependencies.pip.length > 0
    || input.blueprint.dependencies.system.length > 0
    || input.blueprint.dependencies.containers.length > 0;
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    versionId: input.versionId,
    appName: input.plan.appName,
    createdAt: input.createdAt ?? new Date().toISOString(),
    backend: {
      basePath: `/api/app-runtime/${input.projectId}`,
      functions: input.blueprint.backendFunctions,
    },
    database: {
      provider: "nucleus-d1",
      isolation: "project-namespace",
      collections: input.blueprint.collections,
    },
    auth: {
      provider: "nucleus-app-session",
      mode: input.blueprint.authMode,
      sessionTtlSeconds: 24 * 60 * 60,
    },
    dependencies: {
      ...input.blueprint.dependencies,
      execution: requiresExternalRunner ? "external-runner-required" : "edge-native",
    },
    acceptance: {
      checks: (input.plan.acceptanceCriteria ?? input.plan.features).slice(0, 20),
      browserJobRequired: true,
    },
    capabilities: {
      dataApi: "ready",
      auth: "ready",
      runtimeLogs: "ready",
      backups: "ready",
      browserRunner: input.browserRunnerReady ? "ready" : "configuration-required",
      containers: input.containerRunnerReady ? "ready" : "configuration-required",
      gitAutomation: input.gitAutomationReady ? "ready" : "configuration-required",
    },
  };
}

export function collectionSchema(manifest: AppManifest, name: string): AppCollectionSchema | null {
  return manifest.database.collections.find((collection) => collection.name === name) ?? null;
}

function field(name: string, type: RuntimeFieldType, required: boolean, maxLength?: number, defaultValue?: AppCollectionField["default"]): AppCollectionField {
  return {
    name,
    type,
    required,
    ...(maxLength ? { maxLength } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
  };
}

function normalizeCollection(value: unknown): AppCollectionSchema | null {
  const raw = objectValue(value);
  const name = safeName(raw.name);
  if (!name) return null;
  const fields = arrayValue(raw.fields)
    .map((item) => normalizeField(item))
    .filter((item): item is AppCollectionField => item !== null)
    .slice(0, 24);
  if (fields.length === 0) return null;
  const access = ACCESS_MODES.has(raw.access as AppCollectionSchema["access"])
    ? raw.access as AppCollectionSchema["access"]
    : "owner";
  return {
    name,
    label: safeText(raw.label, name, 80),
    access,
    fields,
  };
}

function normalizeField(value: unknown): AppCollectionField | null {
  const raw = objectValue(value);
  const name = safeName(raw.name);
  if (!name) return null;
  const type = FIELD_TYPES.has(raw.type as RuntimeFieldType) ? raw.type as RuntimeFieldType : "string";
  const maxLength = typeof raw.maxLength === "number" && Number.isFinite(raw.maxLength)
    ? Math.max(1, Math.min(32_000, Math.floor(raw.maxLength)))
    : type === "string" ? 2_000 : undefined;
  const defaultValue = validDefault(raw.default, type) ? raw.default as AppCollectionField["default"] : undefined;
  return {
    name,
    type,
    required: raw.required === true,
    ...(maxLength ? { maxLength } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
  };
}

function normalizeFunction(value: unknown): AppBackendFunction | null {
  const raw = objectValue(value);
  const name = safeName(raw.name);
  if (!name) return null;
  const method = raw.method === "GET" ? "GET" : "POST";
  const path = typeof raw.path === "string" && /^\/[a-z0-9_\-/:]{1,120}$/i.test(raw.path)
    ? raw.path
    : `/functions/${name}`;
  return {
    name,
    method,
    path,
    purpose: safeText(raw.purpose, name, 240),
    status: raw.status === "external-runner-required" ? "external-runner-required" : "available",
  };
}

function defaultBackendFunctions(collections: AppCollectionSchema[]): AppBackendFunction[] {
  return collections.flatMap((collection) => ([
    { name: `list_${collection.name}`, method: "GET" as const, path: `/records/${collection.name}`, purpose: `读取${collection.label}`, status: "available" as const },
    { name: `create_${collection.name}`, method: "POST" as const, path: `/records/${collection.name}`, purpose: `创建${collection.label}`, status: "available" as const },
  ])).slice(0, 16);
}

function mergeFunctions(base: AppBackendFunction[], extra: AppBackendFunction[]): AppBackendFunction[] {
  const result = new Map<string, AppBackendFunction>();
  for (const item of [...base, ...extra]) result.set(`${item.method}:${item.path}`, item);
  return [...result.values()].slice(0, 20);
}

function validDefault(value: unknown, type: RuntimeFieldType): boolean {
  if (value === null) return true;
  if (type === "string" || type === "date") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  return type === "json" && (typeof value === "string" || typeof value === "number" || typeof value === "boolean");
}

function safeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!/^[a-zA-Z0-9_\-\s]+$/.test(clean)) return null;
  const normalized = clean.replace(/[-\s]+/g, "_").toLowerCase();
  return NAME_PATTERN.test(normalized) ? normalized : null;
}

function safeText(value: unknown, fallback: string, max: number): string {
  return (typeof value === "string" && value.trim() ? value.trim() : fallback).slice(0, max);
}

function safeStringArray(value: unknown, max: number): string[] {
  return [...new Set(arrayValue(value)
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 120))].slice(0, max);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
