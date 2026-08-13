export type GeneratedFiles = {
  "index.html": string;
  "styles.css": string;
  "script.js": string;
};

export type RuntimeFieldType = "string" | "number" | "boolean" | "date" | "json";

export type AppCollectionField = {
  name: string;
  type: RuntimeFieldType;
  required: boolean;
  maxLength?: number;
  default?: string | number | boolean | null;
};

export type AppCollectionSchema = {
  name: string;
  label: string;
  access: "owner" | "public-read" | "public-write";
  fields: AppCollectionField[];
};

export type AppBackendFunction = {
  name: string;
  method: "GET" | "POST";
  path: string;
  purpose: string;
  status: "available" | "external-runner-required";
};

export type AppRuntimeBlueprint = {
  collections: AppCollectionSchema[];
  authMode: "anonymous" | "account" | "mixed";
  backendFunctions: AppBackendFunction[];
  dependencies: {
    npm: string[];
    pip: string[];
    system: string[];
    containers: string[];
  };
};

export type AppManifest = {
  schemaVersion: 1;
  projectId: string;
  versionId: string;
  appName: string;
  createdAt: string;
  backend: {
    basePath: string;
    functions: AppBackendFunction[];
  };
  database: {
    provider: "nucleus-d1" | "cloudflare-d1";
    isolation: "project-namespace" | "physical-database";
    collections: AppCollectionSchema[];
  };
  auth: {
    provider: "nucleus-app-session";
    mode: AppRuntimeBlueprint["authMode"];
    sessionTtlSeconds: number;
  };
  dependencies: AppRuntimeBlueprint["dependencies"] & {
    execution: "edge-native" | "external-runner-required";
  };
  acceptance: {
    checks: string[];
    browserJobRequired: boolean;
  };
  capabilities: {
    dataApi: "ready";
    auth: "ready";
    runtimeLogs: "ready";
    backups: "ready";
    browserRunner: "ready" | "configuration-required";
    containers: "ready" | "configuration-required";
    gitAutomation: "ready" | "configuration-required";
    physicalDatabase: "ready" | "provisioning" | "configuration-required" | "error";
    email: "ready" | "configuration-required";
    billing: "ready" | "configuration-required";
    observability: "ready" | "configuration-required";
  };
};

export type AppDatabaseResource = {
  projectId: string;
  provider: "cloudflare-d1";
  isolation: "physical-database";
  status: "pending" | "provisioning" | "ready" | "error" | "configuration-required" | "deletion-scheduled" | "deleted";
  externalDatabaseId: string | null;
  databaseName: string;
  locationHint: string | null;
  schemaVersion: number;
  desiredSchemaVersion: number;
  attemptCount: number;
  nextRetryAt: string | null;
  leaseExpiresAt: string | null;
  lastMigrationAt: string | null;
  lastBackupAt: string | null;
  retentionUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProvisioningEvent = {
  id: string;
  projectId: string;
  operation: "create" | "migrate" | "backup" | "restore" | "schedule-delete" | "delete";
  status: "running" | "completed" | "failed" | "configuration-required";
  provider: "cloudflare-d1";
  detail: Record<string, unknown>;
  startedAt: string;
  completedAt: string | null;
};

export type BackupPolicy = {
  projectId: string;
  enabled: boolean;
  intervalHours: number;
  retentionDays: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AppRuntimeActor = {
  id: string;
  type: "account" | "visitor" | "anonymous";
  role: "owner" | "editor" | "reviewer" | "viewer" | "user";
  displayName: string | null;
};

export type AppRuntimeSession = {
  projectId: string;
  token: string;
  refreshToken?: string;
  expiresAt: string;
  actor: AppRuntimeActor;
  manifest: AppManifest;
};

export type AppRecord = {
  id: string;
  projectId: string;
  collection: string;
  ownerSubject: string;
  data: Record<string, unknown>;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeEvidence = {
  id: string;
  projectId: string;
  versionId: string | null;
  source: "preview" | "published" | "browser-runner" | "api";
  level: "info" | "warn" | "error";
  message: string;
  evidence: Record<string, unknown>;
  createdAt: string;
};

export type AppBackup = {
  id: string;
  projectId: string;
  label: string;
  recordCount: number;
  createdBy: string;
  createdAt: string;
  provider?: "snapshot" | "cloudflare-d1-time-travel";
  status?: "ready" | "failed";
  bookmark?: string | null;
  archiveKey?: string | null;
  archiveStatus?: "not-configured" | "pending" | "ready" | "failed";
  archiveBytes?: number | null;
  archiveError?: string | null;
  expiresAt?: string | null;
};

export type RunnerJob = {
  id: string;
  projectId: string;
  versionId: string | null;
  kind: "playwright" | "container-build" | "git-sync";
  status: "queued" | "running" | "passed" | "failed" | "configuration-required";
  provider: string;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type OrganizationMember = {
  id: string;
  organizationId: string;
  subjectId: string;
  email: string | null;
  role: "owner" | "admin" | "editor" | "reviewer" | "viewer";
  status: "active" | "invited" | "suspended";
  createdAt: string;
  updatedAt: string;
};

export type Organization = {
  id: string;
  ownerId: string;
  name: string;
  plan: "demo" | "team" | "enterprise";
  monthlyTokenLimit: number;
  approvalRequired: boolean;
  members: OrganizationMember[];
  usage: {
    month: string;
    tokens: number;
    modelCalls: number;
    databaseWrites: number;
  };
  createdAt: string;
  updatedAt: string;
};

export type ProjectApproval = {
  id: string;
  projectId: string;
  versionId: string;
  status: "pending" | "approved" | "rejected";
  requestedBy: string;
  reviewedBy: string | null;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GitIntegration = {
  projectId: string;
  provider: "github";
  repositoryOwner: string;
  repositoryName: string;
  defaultBranch: string;
  status: "connected" | "configuration-required" | "error";
  installationId?: string | null;
  lastSync: GitSyncResult | null;
  createdAt: string;
  updatedAt: string;
};

export type GitHubAppInstallation = {
  installationId: string;
  accountLogin: string | null;
  accountType: string | null;
  repositorySelection: string | null;
  status: "active" | "suspended" | "revoked";
  createdAt: string;
  updatedAt: string;
};

export type NotificationDelivery = {
  id: string;
  kind: string;
  channel: "email";
  recipient: string;
  status: "queued" | "sent" | "failed" | "configuration-required";
  provider: "resend";
  providerMessageId: string | null;
  error: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
  deliveredAt: string | null;
};

export type BillingAccount = {
  organizationId: string;
  provider: "stripe";
  customerId: string | null;
  subscriptionId: string | null;
  status: "configuration-required" | "checkout-open" | "incomplete" | "trialing" | "active" | "past_due" | "unpaid" | "paused" | "canceled";
  plan: "demo" | "team" | "enterprise";
  currentPeriodEnd: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BillingInvoice = {
  id: string;
  organizationId: string;
  providerInvoiceId: string;
  status: string;
  currency: string;
  amountDue: number;
  amountPaid: number;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OperationalSummary = {
  windowMinutes: number;
  total: number;
  errors: number;
  errorRate: number;
  p95DurationMs: number | null;
  slo: { target: number; healthy: boolean; availabilityHealthy: boolean; latencyHealthy: boolean; latencyTargetMs: number };
  alerting: "ready" | "configuration-required";
};

export type GitSyncResult = {
  runId: string;
  branches: Array<{ agent: "Iris" | "Bob" | "Alex" | "Ray"; branch: string; commitSha: string }>;
  mergedCommitSha: string | null;
  repositoryUrl: string;
  completedAt: string;
};

export type RaceCandidate = {
  id: string;
  runId: string;
  projectId: string;
  stage: string;
  model: string;
  score: number;
  selected: boolean;
  outputChars: number;
  createdAt: string;
};

export type AgentPlan = {
  appName: string;
  summary: string;
  features: string[];
  design: string;
  acceptanceCriteria?: string[];
  risks?: string[];
  archetype?: string;
  testPlan?: string[];
};

export type AgentName = "Iris" | "Bob" | "Alex" | "Ray";

export type GenerationStage =
  | "requirements"
  | "architecture"
  | "implementation:index.html"
  | "implementation:styles.css"
  | "implementation:script.js"
  | "quality"
  | "repair"
  | "finalize"
  | "completed";

export type GenerationArtifactKind =
  | "requirements"
  | "architecture"
  | "manifest"
  | "index.html"
  | "styles.css"
  | "script.js"
  | "quality";

export type GenerationArtifact = {
  id: string;
  runId: string;
  projectId: string;
  agent: AgentName;
  kind: GenerationArtifactKind;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type ModelAttemptRecord = {
  id: string;
  runId: string;
  projectId: string;
  agent: AgentName;
  phase: string;
  model: string;
  status: "success" | "recovered" | "empty" | "incomplete" | "http_error" | "timeout" | "network_error" | "budget_exceeded" | "cancelled";
  durationMs: number;
  firstTokenMs: number | null;
  outputChars: number;
  statusCode: number | null;
  usage: ModelUsage;
  error: string | null;
  createdAt: string;
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
  mode: "standard" | "race";
  currentStage: GenerationStage;
  events: GenerationEvent[];
  artifacts: GenerationArtifact[];
  attempts: ModelAttemptRecord[];
  candidates: RaceCandidate[];
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
  manifest: AppManifest | null;
  createdAt: string;
};

export type ProjectIntakeOption = {
  id: string;
  label: string;
  description: string;
  promptSuffix: string;
  recommended: boolean;
};

export type ProjectIntake = {
  summary: string;
  assumptions: string[];
  question: string;
  options: ProjectIntakeOption[];
  source: "model" | "deterministic-recovery";
};

export type Project = {
  id: string;
  title: string;
  prompt: string;
  status: "draft" | "generating" | "ready" | "error";
  plan: AgentPlan | null;
  intake: ProjectIntake | null;
  manifest: AppManifest | null;
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
  | { type: "progress"; agent: AgentName; phase: string; label: string; delta: string; totalChars: number; done: boolean; model: string }
  | { type: "plan"; plan: AgentPlan }
  | { type: "file"; path: keyof GeneratedFiles; size: number }
  | { type: "artifact"; artifact: GenerationArtifact }
  | { type: "step_complete"; runId: string; stage: GenerationStage; nextStage: GenerationStage; terminal: boolean }
  | { type: "review"; report: AppQualityReport }
  | { type: "complete"; project: Project }
  | { type: "error"; message: string; retryable?: boolean; stage?: GenerationStage }
) & { audit?: AgentAudit };
