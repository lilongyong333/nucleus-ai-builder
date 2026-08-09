export type GeneratedFiles = {
  "index.html": string;
  "styles.css": string;
  "script.js": string;
};

export type AgentPlan = {
  appName: string;
  summary: string;
  features: string[];
  design: string;
};

export type AppQualityCheck = {
  id: string;
  label: string;
  severity: "pass" | "warning" | "error";
  detail: string;
  weight: number;
};

export type AppQualityReport = {
  score: number;
  grade: "A" | "B" | "C" | "D";
  passed: boolean;
  checks: AppQualityCheck[];
  summary: string;
};

export type ModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type GenerationEvent = {
  id: string;
  runId: string;
  projectId: string;
  sequence: number;
  agent: string;
  phase: string;
  state: "working" | "done" | "error";
  title: string;
  detail: string;
  durationMs: number | null;
  model: string | null;
  usage: ModelUsage;
  createdAt: string;
};

export type GenerationRun = {
  id: string;
  projectId: string;
  prompt: string;
  status: "running" | "completed" | "failed" | "cancelled" | "rejected";
  model: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  usage: ModelUsage;
  modelCalls: number;
  repairCount: number;
  versionId: string | null;
  error: string | null;
  events: GenerationEvent[];
};

export type ProjectMessage = {
  id: string;
  projectId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type ProjectVersion = {
  id: string;
  projectId: string;
  versionNumber: number;
  files: GeneratedFiles;
  summary: string;
  model: string;
  quality: AppQualityReport | null;
  createdAt: string;
};

export type Project = {
  id: string;
  title: string;
  prompt: string;
  status: "draft" | "generating" | "ready" | "error";
  plan: AgentPlan | null;
  files: GeneratedFiles;
  currentVersionId: string | null;
  publishedVersionId: string | null;
  slug: string | null;
  createdAt: string;
  updatedAt: string;
  versions: ProjectVersion[];
  runs: GenerationRun[];
  messages: ProjectMessage[];
};

export type AgentAudit = {
  runId: string;
  eventId: string;
  phase: string;
  sequence: number;
  durationMs?: number;
  model?: string;
  usage?: ModelUsage;
};

export type AgentEvent = (
  | { type: "status"; agent: string; title: string; detail: string; state: "working" | "done" }
  | { type: "plan"; plan: AgentPlan }
  | { type: "file"; path: keyof GeneratedFiles; size: number }
  | { type: "review"; report: AppQualityReport }
  | { type: "complete"; project: Project }
  | { type: "error"; message: string }
) & { audit?: AgentAudit };
