import { env } from "cloudflare:workers";
import { createModelBudget, requestChat, type ChatMessage, type GatewayChatResult, type ModelAttempt, type ModelBudget } from "./model-gateway";
import { extractGeneratedFiles, parseGeneratedReply } from "./parser";
import { planFromPrompt } from "./planner";
import { qualityRepairBrief, reviewGeneratedApp, reviewProductContract } from "./quality";
import { addUsage, emptyUsage } from "./usage";
import type { AgentName, AgentPlan, AppQualityCheck, AppQualityReport, GeneratedFiles, ModelUsage } from "./types";

function runtimeValue(name: string, fallback = ""): string {
  const cloud = env as unknown as Record<string, unknown>;
  const value = cloud[name] ?? process.env[name];
  return typeof value === "string" && value ? value : fallback;
}

export function activeModel(): string {
  return runtimeValue("OPENCODE_GO_MODEL", "gpt-5.6-luna");
}

export function activeModels(): string[] {
  return [...new Set([activeModel(), runtimeValue("OPENCODE_GO_FALLBACK_MODEL", "glm-5.2")].filter(Boolean))];
}

function runtimeInteger(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(runtimeValue(name, String(fallback)));
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? Math.floor(parsed) : fallback));
}

export function generationBudgetLimits(): { maxCalls: number; maxTotalTokens: number } {
  return {
    maxCalls: runtimeInteger("OPENCODE_GO_MAX_MODEL_CALLS", 24, 1, 40),
    maxTotalTokens: runtimeInteger("OPENCODE_GO_MAX_TOTAL_TOKENS", 180_000, 1_000, 200_000),
  };
}

export function createGenerationBudget(): ModelBudget {
  const limits = generationBudgetLimits();
  return createModelBudget({
    maxCalls: limits.maxCalls,
    maxTotalTokens: limits.maxTotalTokens,
    maxDurationMs: runtimeInteger("OPENCODE_GO_MAX_DURATION_MS", 48_000, 5_000, 55_000),
  });
}

export function createStepBudget(remaining?: { maxCalls: number; maxTotalTokens: number }): ModelBudget {
  const configuredCalls = runtimeInteger("OPENCODE_GO_STEP_MAX_CALLS", 2, 1, 4);
  const configuredTokens = runtimeInteger("OPENCODE_GO_STEP_MAX_TOTAL_TOKENS", 40_000, 2_000, 80_000);
  return createModelBudget({
    maxCalls: Math.min(configuredCalls, remaining?.maxCalls ?? configuredCalls),
    maxTotalTokens: Math.min(configuredTokens, remaining?.maxTotalTokens ?? configuredTokens),
    maxDurationMs: runtimeInteger("OPENCODE_GO_STEP_MAX_DURATION_MS", 47_000, 10_000, 52_000),
  });
}

export type GenerationProgress = {
  agent: AgentName;
  phase: string;
  label: string;
  delta: string;
  totalChars: number;
  done: boolean;
  model: string;
};

type ProgressStage = Pick<GenerationProgress, "agent" | "phase" | "label">;

async function chat(messages: ChatMessage[], maxTokens: number, budget: ModelBudget, signal?: AbortSignal, progress?: { stage: ProgressStage; report: (event: GenerationProgress) => void }): Promise<GatewayChatResult> {
  const apiKey = runtimeValue("OPENCODE_GO_API_KEY");
  if (!apiKey) throw new Error("站点还没有配置 OpenCode Go API Key");
  let lastTotalChars = 0;
  const result = await requestChat({
    baseUrl: runtimeValue("OPENCODE_GO_BASE_URL", "https://opencode.ai/zen/go/v1"),
    apiKey,
    models: activeModels(),
    messages,
    maxTokens,
    requestTimeoutMs: runtimeInteger("OPENCODE_GO_REQUEST_TIMEOUT_MS", 26_000, 5_000, 45_000),
    fallbackReserveMs: runtimeInteger("OPENCODE_GO_FALLBACK_RESERVE_MS", 18_000, 5_000, 30_000),
    emptyRetriesPerModel: 0,
    budget,
    signal,
    onDelta: progress ? (update) => {
      lastTotalChars = update.totalChars;
      progress.report({ ...progress.stage, ...update, done: false });
    } : undefined,
  });
  if (progress) progress.report({ ...progress.stage, model: result.model, delta: "", totalChars: lastTotalChars || result.content.length, done: true });
  return result;
}

export async function createPlan(prompt: string, currentFiles?: GeneratedFiles, signal?: AbortSignal, budget = createGenerationBudget()): Promise<{ plan: AgentPlan; usage: ModelUsage; durationMs: number; modelCalls: number; model: string; usedFallback: boolean }> {
  void budget;
  const startedAt = Date.now();
  signal?.throwIfAborted();
  return { plan: planFromPrompt(prompt, Boolean(currentFiles)), usage: emptyUsage(), durationMs: Date.now() - startedAt, modelCalls: 0, model: "Iris deterministic SOP", usedFallback: false };
}

export type ArchitectureArtifact = {
  summary: string;
  visualDirection: string;
  informationArchitecture: string[];
  stateModel: string[];
  interactionFlow: string[];
  fileResponsibilities: Record<keyof GeneratedFiles, string>;
  testPlan: string[];
};

export type RayReviewArtifact = {
  passed: boolean;
  summary: string;
  functionalChecks: Array<{ name: string; passed: boolean; evidence: string }>;
  issues: Array<{ severity: "warning" | "error"; file: keyof GeneratedFiles | "application"; detail: string }>;
  deterministic: AppQualityReport;
  productChecks: AppQualityCheck[];
};

export type AgentModelResult<T> = {
  artifact: T;
  raw: string;
  usage: ModelUsage;
  durationMs: number;
  modelCalls: number;
  model: string;
  attempts: ModelAttempt[];
};

export class AgentOutputError extends Error {
  constructor(message: string, readonly result: GatewayChatResult) {
    super(message);
    this.name = "AgentOutputError";
  }
}

export async function runIrisAgent(prompt: string, currentFiles: GeneratedFiles | undefined, signal: AbortSignal | undefined, budget: ModelBudget, report?: (event: GenerationProgress) => void): Promise<AgentModelResult<AgentPlan>> {
  const startedAt = Date.now();
  const result = await chat([
    { role: "system", content: "You are Iris, a principal product manager in a real software team. Convert the request into an implementation contract. Return compact valid JSON only with keys: appName (string), summary (string), archetype (string), features (5-10 strings), acceptanceCriteria (6-14 independently testable strings), risks (2-6 strings), design (string), testPlan (5-12 strings). Resolve obvious product details instead of asking questions. For games, cover controls, rules, scoring, lifecycle, accessibility, responsive behavior and persistence where appropriate. Do not return markdown or reasoning." },
    { role: "user", content: `User request:\n${prompt}${currentFiles ? "\nThis is an iteration of an existing three-file application; preserve working behavior unless explicitly replaced." : ""}` },
  ], runtimeInteger("OPENCODE_GO_IRIS_MAX_TOKENS", 6_000, 1_000, 16_000), budget, signal, report ? { stage: { agent: "Iris", phase: "requirements:model", label: "Iris 正在形成可验收需求" }, report } : undefined);
  const parsed = parseAgentJson(result, "Iris 没有返回可解析的需求工件");
  const deterministic = planFromPrompt(prompt, Boolean(currentFiles));
  const plan: AgentPlan = {
    appName: stringValue(parsed.appName, deterministic.appName, 80),
    summary: stringValue(parsed.summary, deterministic.summary, 500),
    archetype: stringValue(parsed.archetype, "interactive-web-app", 80),
    features: stringArray(parsed.features, deterministic.features, 12),
    acceptanceCriteria: stringArray(parsed.acceptanceCriteria, deterministic.features, 16),
    risks: stringArray(parsed.risks, ["模型输出必须保持三文件协议", "所有核心交互必须可在沙箱中运行"], 8),
    design: stringValue(parsed.design, deterministic.design, 500),
    testPlan: stringArray(parsed.testPlan, deterministic.features.map((feature) => `验证：${feature}`), 14),
  };
  return modelResult(plan, result, startedAt);
}

export async function runBobAgent(prompt: string, plan: AgentPlan, currentFiles: GeneratedFiles | undefined, signal: AbortSignal | undefined, budget: ModelBudget, report?: (event: GenerationProgress) => void): Promise<AgentModelResult<ArchitectureArtifact>> {
  const startedAt = Date.now();
  const result = await chat([
    { role: "system", content: "You are Bob, a senior frontend architect. Produce a concrete architecture handoff for a no-build vanilla HTML/CSS/JavaScript application. Return compact valid JSON only with keys: summary, visualDirection, informationArchitecture (array), stateModel (array), interactionFlow (array), fileResponsibilities (object with index.html, styles.css, script.js), testPlan (array). Make every acceptance criterion implementable and testable. Do not return markdown or reasoning." },
    { role: "user", content: `Original request:\n${prompt}\n\nIris requirements:\n${JSON.stringify(plan)}${currentFiles ? "\n\nAn existing version will be supplied to Alex for a safe iteration." : ""}` },
  ], runtimeInteger("OPENCODE_GO_BOB_MAX_TOKENS", 7_000, 1_000, 18_000), budget, signal, report ? { stage: { agent: "Bob", phase: "architecture:model", label: "Bob 正在设计状态、交互和测试契约" }, report } : undefined);
  const parsed = parseAgentJson(result, "Bob 没有返回可解析的架构工件");
  const fileResponsibilities = objectValue(parsed.fileResponsibilities);
  const architecture: ArchitectureArtifact = {
    summary: stringValue(parsed.summary, `以三文件自包含架构实现 ${plan.appName}`, 600),
    visualDirection: stringValue(parsed.visualDirection, plan.design, 500),
    informationArchitecture: stringArray(parsed.informationArchitecture, plan.features, 14),
    stateModel: stringArray(parsed.stateModel, ["单一可预测应用状态", "渲染由状态驱动", "所有用户动作都有明确状态迁移"], 16),
    interactionFlow: stringArray(parsed.interactionFlow, plan.acceptanceCriteria ?? plan.features, 18),
    fileResponsibilities: {
      "index.html": stringValue(fileResponsibilities["index.html"], "语义结构、可访问控件和应用容器", 400),
      "styles.css": stringValue(fileResponsibilities["styles.css"], "产品级视觉、响应式布局、动效和焦点状态", 400),
      "script.js": stringValue(fileResponsibilities["script.js"], "完整状态机、业务规则、交互、持久化和错误处理", 400),
    },
    testPlan: stringArray(parsed.testPlan, plan.testPlan ?? plan.features.map((feature) => `验证：${feature}`), 18),
  };
  return modelResult(architecture, result, startedAt);
}

export async function runAlexFileAgent(path: keyof GeneratedFiles, prompt: string, plan: AgentPlan, architecture: ArchitectureArtifact, files: Partial<GeneratedFiles>, currentFiles: GeneratedFiles | undefined, signal: AbortSignal | undefined, budget: ModelBudget, report?: (event: GenerationProgress) => void): Promise<AgentModelResult<string>> {
  const startedAt = Date.now();
  const availableFiles = { ...(currentFiles ?? {}), ...files };
  const context = Object.entries(availableFiles).map(([name, content]) => `--- ${name} ---\n${content}`).join("\n\n");
  const pathRule = path === "index.html"
    ? "Return complete semantic body markup and head metadata. Do not include inline style or script tags. Every visible primary control needs a stable id or data attribute."
    : path === "styles.css"
      ? "Return complete responsive CSS. Include desktop and mobile layouts, clear focus-visible states, reduced-motion support, polished empty/error/active states, and no external assets."
      : "Return complete executable vanilla JavaScript. Implement every acceptance criterion and interaction, robust state transitions, keyboard and touch behavior where relevant, defensive DOM access, and localStorage only for device-local app data. No imports or external libraries.";
  const result = await chat([
    { role: "system", content: `You are Alex, an elite implementation engineer. Generate exactly one production-ready file: ${path}. ${pathRule} Output only one markdown code block with the exact opening line \`\`\`${languageFor(path)}{path=${path}}. Do not include reasoning or any other file. The file may be detailed; correctness and completeness are more important than brevity. Never put markdown fences inside the file.` },
    { role: "user", content: `Original request:\n${prompt}\n\nIris contract:\n${JSON.stringify(plan)}\n\nBob architecture:\n${JSON.stringify(architecture)}${context ? `\n\nFiles available for cross-file consistency:\n${context}` : ""}` },
  ], runtimeInteger(`OPENCODE_GO_${path === "index.html" ? "HTML" : path === "styles.css" ? "CSS" : "JS"}_MAX_TOKENS`, 12_000, 2_000, 24_000), budget, signal, report ? { stage: { agent: "Alex", phase: `implementation:${path}`, label: `Alex 正在生成 ${path}` }, report } : undefined);
  const content = extractSingleFile(path, result.content);
  if (content.length < 40) throw new AgentOutputError(`${path} 输出过短，未形成可用工件`, result);
  if (content.length > 120_000) throw new AgentOutputError(`${path} 超过 120KB 安全上限`, result);
  return modelResult(content, result, startedAt);
}

export async function runRayReviewAgent(prompt: string, plan: AgentPlan, architecture: ArchitectureArtifact, files: GeneratedFiles, signal: AbortSignal | undefined, budget: ModelBudget, report?: (event: GenerationProgress) => void): Promise<AgentModelResult<RayReviewArtifact>> {
  const startedAt = Date.now();
  const deterministic = reviewGeneratedApp(files);
  const productChecks = reviewProductContract(prompt, files);
  const result = await chat([
    { role: "system", content: "You are Ray, a skeptical senior QA and code reviewer. Inspect the complete three-file application against every acceptance criterion and test plan. Return compact valid JSON only: passed (boolean), summary (string), functionalChecks (array of {name,passed,evidence}), issues (array of {severity: warning|error,file: index.html|styles.css|script.js|application,detail}). Mark error only for a concrete functional, runtime, safety, or acceptance failure. Do not invent missing behavior when code evidence proves it exists. Do not return markdown or reasoning." },
    { role: "user", content: `Original request:\n${prompt}\n\nIris contract:\n${JSON.stringify(plan)}\n\nBob architecture:\n${JSON.stringify(architecture)}\n\nDeterministic checks:\n${JSON.stringify(deterministic)}\n\nArchetype contract checks:\n${JSON.stringify(productChecks)}\n\nFiles:\n--- index.html ---\n${files["index.html"]}\n--- styles.css ---\n${files["styles.css"]}\n--- script.js ---\n${files["script.js"]}` },
  ], runtimeInteger("OPENCODE_GO_RAY_MAX_TOKENS", 8_000, 1_500, 18_000), budget, signal, report ? { stage: { agent: "Ray", phase: "quality:model", label: "Ray 正在核对验收标准和代码证据" }, report } : undefined);
  const parsed = parseAgentJson(result, "Ray 没有返回可解析的质量工件");
  const functionalChecks = arrayObjects(parsed.functionalChecks).slice(0, 24).map((item, index) => ({
    name: stringValue(item.name, `功能检查 ${index + 1}`, 180),
    passed: item.passed !== false,
    evidence: stringValue(item.evidence, "已检查实现代码", 400),
  }));
  const issues = arrayObjects(parsed.issues).slice(0, 16).map((item) => ({
    severity: item.severity === "error" ? "error" as const : "warning" as const,
    file: (["index.html", "styles.css", "script.js"] as const).includes(item.file as keyof GeneratedFiles) ? item.file as keyof GeneratedFiles : "application" as const,
    detail: stringValue(item.detail, "需要人工复核", 500),
  }));
  const passed = deterministic.passed
    && productChecks.every((check) => check.severity !== "error")
    && parsed.passed !== false
    && !issues.some((issue) => issue.severity === "error");
  const artifact: RayReviewArtifact = {
    passed,
    summary: stringValue(parsed.summary, deterministic.summary, 600),
    functionalChecks,
    issues,
    deterministic,
    productChecks,
  };
  return modelResult(artifact, result, startedAt);
}

export async function runRayRepairAgent(prompt: string, plan: AgentPlan, architecture: ArchitectureArtifact, review: RayReviewArtifact, files: GeneratedFiles, signal: AbortSignal | undefined, budget: ModelBudget, report?: (event: GenerationProgress) => void): Promise<AgentModelResult<Partial<GeneratedFiles>>> {
  const startedAt = Date.now();
  const result = await chat([
    { role: "system", content: "You are Ray acting as the repair engineer. Fix every concrete error in the QA report while preserving working behavior. Return only the complete changed files as markdown code blocks with exact {path=index.html}, {path=styles.css}, or {path=script.js} opening-line metadata. Do not return unchanged files, explanations, summaries, or JSON. Never put markdown fences inside a file." },
    { role: "user", content: `Original request:\n${prompt}\n\nIris contract:\n${JSON.stringify(plan)}\n\nBob architecture:\n${JSON.stringify(architecture)}\n\nQA report:\n${JSON.stringify(review)}\n\nCurrent files:\n--- index.html ---\n${files["index.html"]}\n--- styles.css ---\n${files["styles.css"]}\n--- script.js ---\n${files["script.js"]}` },
  ], runtimeInteger("OPENCODE_GO_REPAIR_MAX_TOKENS", 16_000, 2_000, 24_000), budget, signal, report ? { stage: { agent: "Ray", phase: "quality:repair", label: "Ray 正在按失败证据修复工件" }, report } : undefined);
  const changed = extractGeneratedFiles(result.content);
  if (Object.keys(changed).length === 0) throw new AgentOutputError("Ray 没有返回可解析的修复文件", result);
  return modelResult(changed, result, startedAt);
}

function modelResult<T>(artifact: T, result: GatewayChatResult, startedAt: number): AgentModelResult<T> {
  return { artifact, raw: result.content, usage: result.usage, durationMs: Date.now() - startedAt, modelCalls: result.calls, model: result.model, attempts: result.attempts };
}

function parseAgentJson(result: GatewayChatResult, message: string): Record<string, unknown> {
  try {
    return jsonObject(result.content);
  } catch {
    throw new AgentOutputError(message, result);
  }
}

function jsonObject(raw: string): Record<string, unknown> {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回可解析的 JSON 工件");
  const parsed = JSON.parse(stripped.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("模型 JSON 工件格式错误");
  return parsed as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
}

function stringValue(value: unknown, fallback: string, max: number): string {
  return (typeof value === "string" && value.trim() ? value.trim() : fallback).slice(0, max);
}

function stringArray(value: unknown, fallback: string[], max: number): string[] {
  const values = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
  return [...new Set(values.length ? values : fallback)].slice(0, max);
}

function languageFor(path: keyof GeneratedFiles): string {
  return path === "index.html" ? "html" : path === "styles.css" ? "css" : "js";
}

function extractSingleFile(path: keyof GeneratedFiles, raw: string): string {
  const tagged = extractGeneratedFiles(raw)[path];
  if (tagged) return tagged.trim();
  const generic = raw.trim().match(/^```(?:html|css|javascript|js)?\s*\r?\n([\s\S]*?)\r?\n```$/i)?.[1];
  return (generic ?? raw).trim();
}

export async function buildApp(prompt: string, plan: AgentPlan, currentFiles?: GeneratedFiles, signal?: AbortSignal, budget = createGenerationBudget(), reportProgress?: (event: GenerationProgress) => void): Promise<{ files: GeneratedFiles; summary: string; quality: AppQualityReport; usage: ModelUsage; durationMs: number; modelCalls: number; repairCount: number; model: string; models: string[]; usedFallback: boolean }> {
  const startedAt = Date.now();
  let usage = emptyUsage();
  let modelCalls = 0;
  let repairCount = 0;
  const models = new Set<string>();
  const existing = currentFiles ? `\nExisting files to improve:\n${Object.entries(currentFiles).map(([path, content]) => `--- ${path} ---\n${content}`).join("\n")}` : "";
  const initial = await chat([
    { role: "system", content: `You are Alex, an elite frontend engineer. Do not reveal reasoning; start the final artifact immediately. Build a polished, fully interactive browser app with no build step. Output exactly one short Chinese summary wrapped in <summary>...</summary>, followed by exactly three markdown code blocks whose opening lines are:\n\`\`\`html{path=index.html}\n\`\`\`css{path=styles.css}\n\`\`\`js{path=script.js}\nRules: use semantic HTML; responsive CSS; vanilla JavaScript; no external libraries; no SVG; no placeholder buttons; every visible primary control must work; keep each file under 60KB; do not include style or script tags in index.html; index.html must contain complete body markup; all three files must be complete; keep the entire response compact and under 2800 tokens. Never place markdown fences inside a generated file.` },
    { role: "user", content: `Request: ${prompt}\nPlan: ${JSON.stringify(plan)}${existing}` },
  ], 3600, budget, signal, reportProgress ? { stage: { agent: "Alex", phase: "implementation:initial", label: "正在实时生成页面、样式和交互" }, report: reportProgress } : undefined);
  models.add(initial.model);
  let raw = initial.content;
  usage = addUsage(usage, initial.usage);
  modelCalls += initial.calls;
  if (!currentFiles) {
    const partial = extractGeneratedFiles(raw);
    const missing = (["index.html", "styles.css", "script.js"] as const).filter((path) => !partial[path]);
    if (missing.length > 0) {
      const repair = await chat([
        { role: "system", content: `You are repairing an incomplete artifact. Return only markdown code blocks for these missing files: ${missing.join(", ")}. Use the exact {path=filename} opening-line format. Do not repeat files that already exist. No reasoning.` },
        { role: "user", content: `Original request: ${prompt}\nPlan: ${JSON.stringify(plan)}\nExisting generated files:\n${Object.entries(partial).map(([path, content]) => `--- ${path} ---\n${content}`).join("\n")}` },
      ], 2200, budget, signal, reportProgress ? { stage: { agent: "Alex", phase: "implementation:missing", label: `正在补齐 ${missing.join("、")}` }, report: reportProgress } : undefined);
      models.add(repair.model);
      raw = `${raw}\n${repair.content}`;
      usage = addUsage(usage, repair.usage);
      modelCalls += repair.calls;
      repairCount += 1;
    }
  }
  let parsed = parseGeneratedReply(raw, `完成 ${plan.appName}`, currentFiles);
  let quality = reviewGeneratedApp(parsed.files);

  if (!quality.passed) {
    const repair = await chat([
      { role: "system", content: "You are Ray, a senior frontend QA engineer. Repair the supplied browser app so every reported quality issue is resolved without removing working features. Return only the changed files as markdown code blocks using the exact {path=filename} format. Do not include reasoning, JSON, or unchanged files." },
      { role: "user", content: `Original request: ${prompt}\nPlan: ${JSON.stringify(plan)}\nQuality report:\n${qualityRepairBrief(quality)}\n\nFiles to repair:\n${Object.entries(parsed.files).map(([path, content]) => `--- ${path} ---\n${content}`).join("\n")}` },
    ], 2600, budget, signal, reportProgress ? { stage: { agent: "Ray", phase: "quality:repair", label: "正在实时修复质量门问题" }, report: reportProgress } : undefined);
    models.add(repair.model);
    parsed = parseGeneratedReply(repair.content, parsed.summary, parsed.files);
    usage = addUsage(usage, repair.usage);
    modelCalls += repair.calls;
    repairCount += 1;
    quality = reviewGeneratedApp(parsed.files);
  }

  if (!quality.passed) {
    throw new Error(`Ray 质量门未通过：${qualityRepairBrief(quality).replace(/\n/g, "；").slice(0, 320)}`);
  }
  const usedModels = [...models];
  return { ...parsed, quality, usage, durationMs: Date.now() - startedAt, modelCalls, repairCount, model: usedModels.join(" → "), models: usedModels, usedFallback: usedModels.some((item) => item !== activeModels()[0]) };
}
