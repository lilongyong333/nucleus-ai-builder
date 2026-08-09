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
  slug: string | null;
  createdAt: string;
  updatedAt: string;
  versions: ProjectVersion[];
};

export type AgentEvent =
  | { type: "status"; agent: string; title: string; detail: string; state: "working" | "done" }
  | { type: "plan"; plan: AgentPlan }
  | { type: "file"; path: keyof GeneratedFiles; size: number }
  | { type: "review"; report: AppQualityReport }
  | { type: "complete"; project: Project }
  | { type: "error"; message: string };
