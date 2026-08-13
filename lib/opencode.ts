import { env } from "cloudflare:workers";
import { normalizeRuntimeBlueprint } from "./app-manifest";
import { scoreFileCandidate } from "./race-score";
import { artifactProtocolViolation, canonicalFileResponsibilities, normalizeArtifactContent } from "./artifact-protocol";
import { createModelBudget, ModelGatewayError, requestChat, type ChatMessage, type GatewayChatResult, type ModelAttempt, type ModelBudget } from "./model-gateway";
import { extractGeneratedFiles, parseGeneratedReply } from "./parser";
import { planFromPrompt } from "./planner";
import { qualityIssuesFromChecks, qualityRepairBrief, requiredQualityIssueFiles, reviewGeneratedApp, reviewProductContract } from "./quality";
import { isCompleteJsonArtifact, isCompleteRepairArtifact, isCompleteSingleFileArtifact, isCompleteThreeFileArtifact, parseStructuredJsonObject } from "./structured-output";
import { addUsage, emptyUsage } from "./usage";
import type { AgentName, AgentPlan, AppQualityCheck, AppQualityReport, AppRuntimeBlueprint, GeneratedFiles, ModelUsage, ProjectIntake, ProjectIntakeOption } from "./types";

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

export function activeCodeModels(): string[] {
  return [...new Set([
    runtimeValue("OPENCODE_GO_CODE_MODEL", "glm-5.2"),
    runtimeValue("OPENCODE_GO_CODE_FALLBACK_MODEL", "gpt-5.6-luna"),
  ].filter(Boolean))];
}

function runtimeInteger(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(runtimeValue(name, String(fallback)));
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? Math.floor(parsed) : fallback));
}

export function generationBudgetLimits(): { maxCalls: number; maxTotalTokens: number } {
  return {
    maxCalls: runtimeInteger("OPENCODE_GO_MAX_MODEL_CALLS", 60, 1, 80),
    maxTotalTokens: runtimeInteger("OPENCODE_GO_MAX_TOTAL_TOKENS", 500_000, 1_000, 1_000_000),
  };
}

export function createGenerationBudget(): ModelBudget {
  const limits = generationBudgetLimits();
  return createModelBudget({
    maxCalls: limits.maxCalls,
    maxTotalTokens: limits.maxTotalTokens,
    maxDurationMs: runtimeInteger("OPENCODE_GO_MAX_DURATION_MS", 240_000, 5_000, 285_000),
  });
}

export function createStepBudget(remaining?: { maxCalls: number; maxTotalTokens: number }): ModelBudget {
  const configuredCalls = runtimeInteger("OPENCODE_GO_STEP_MAX_CALLS", 4, 1, 8);
  const configuredTokens = runtimeInteger("OPENCODE_GO_STEP_MAX_TOTAL_TOKENS", 100_000, 2_000, 250_000);
  return createModelBudget({
    maxCalls: Math.min(configuredCalls, remaining?.maxCalls ?? configuredCalls),
    maxTotalTokens: Math.min(configuredTokens, remaining?.maxTotalTokens ?? configuredTokens),
    // A generated CSS/JavaScript file regularly needs longer than the old
    // 52-second window. The route emits heartbeats, so wall-clock I/O can stay
    // open while the provider finishes without consuming unbounded CPU time.
    maxDurationMs: runtimeInteger("OPENCODE_GO_STEP_MAX_DURATION_MS", 280_000, 10_000, 285_000),
  });
}

export function createIntakeBudget(): ModelBudget {
  return createModelBudget({ maxCalls: 2, maxTotalTokens: 24_000, maxDurationMs: 90_000 });
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

type ChatOptions = { models?: string[]; requestTimeoutMs?: number; firstTokenTimeoutMs?: number; fallbackReserveMs?: number; acceptIncomplete?: (content: string) => boolean };

function codeChatOptions(): ChatOptions {
  return {
    models: activeCodeModels(),
    requestTimeoutMs: runtimeInteger("OPENCODE_GO_CODE_REQUEST_TIMEOUT_MS", 170_000, 8_000, 180_000),
    firstTokenTimeoutMs: runtimeInteger("OPENCODE_GO_CODE_FIRST_TOKEN_TIMEOUT_MS", 75_000, 8_000, 120_000),
    fallbackReserveMs: runtimeInteger("OPENCODE_GO_CODE_FALLBACK_RESERVE_MS", 50_000, 5_000, 90_000),
  };
}

async function chat(messages: ChatMessage[], maxTokens: number, budget: ModelBudget, signal?: AbortSignal, progress?: { stage: ProgressStage; report: (event: GenerationProgress) => void }, options: ChatOptions = {}): Promise<GatewayChatResult> {
  const apiKey = runtimeValue("OPENCODE_GO_API_KEY");
  if (!apiKey) throw new Error("站点还没有配置 OpenCode Go API Key");
  let lastTotalChars = 0;
  const result = await requestChat({
    baseUrl: runtimeValue("OPENCODE_GO_BASE_URL", "https://opencode.ai/zen/go/v1"),
    apiKey,
    models: options.models ?? activeModels(),
    messages,
    maxTokens,
    requestTimeoutMs: options.requestTimeoutMs ?? runtimeInteger("OPENCODE_GO_REQUEST_TIMEOUT_MS", 26_000, 5_000, 45_000),
    firstTokenTimeoutMs: options.firstTokenTimeoutMs,
    fallbackReserveMs: options.fallbackReserveMs ?? runtimeInteger("OPENCODE_GO_FALLBACK_RESERVE_MS", 18_000, 5_000, 30_000),
    emptyRetriesPerModel: 0,
    budget,
    signal,
    acceptIncomplete: options.acceptIncomplete,
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

export function deterministicProjectIntake(prompt: string, reason?: string): ProjectIntake {
  const request = prompt.trim();
  const isGame = /(游戏|game|贪吃蛇|snake|打砖块|2048|俄罗斯方块)/i.test(request);
  const isData = /(看板|dashboard|财务|预算|支出|收入|数据|报表|kanban|finance|budget)/i.test(request);
  const presets = isGame
    ? [
        ["neon", "霓虹竞技", "高对比深色舞台、强反馈动效，适合强调挑战感。", "采用霓虹竞技视觉；必须包含清晰规则、开始/暂停/重开、键盘与触控、计分和失败反馈。"],
        ["casual", "清爽休闲", "明亮留白、圆润组件和克制动画，长时间使用更舒服。", "采用清爽休闲视觉；优先可读性、移动端触控、无障碍焦点和温和动效。"],
        ["pixel", "复古像素", "像素化层次与怀旧配色，但保留现代响应式交互。", "采用复古像素视觉；保留现代键盘/触控可用性、响应式布局和完整生命周期。"],
      ]
    : isData
      ? [
          ["professional", "专业克制", "信息层级清楚、配色稳重，适合真实业务使用。", "采用专业克制的数据产品风格；突出关键指标、真实增删改查、筛选、空状态与响应式布局。"],
          ["dense", "数据密集", "同屏展示更多指标和记录，适合高频分析。", "采用数据密集的工作台风格；提供紧凑表格/卡片、快速筛选、汇总联动和键盘可达性。"],
          ["friendly", "温暖生活化", "低压配色和引导式文案，适合个人长期记录。", "采用温暖生活化风格；强调清晰表单、即时反馈、空状态切换、数据持久化和移动端体验。"],
        ]
      : [
          ["minimal", "极简实用", "减少装饰，把核心任务和操作路径放在第一位。", "采用极简实用风格；所有核心控件真实可用，覆盖空状态、错误反馈、持久化和响应式布局。"],
          ["productivity", "专业信息密集", "更像成熟 SaaS 工作台，适合复杂操作和扩展。", "采用专业 SaaS 工作台风格；提供清晰导航、状态反馈、完整 CRUD、键盘可达性和可扩展信息架构。"],
          ["expressive", "大胆表现力", "使用更强的色彩、排版和动效，突出作品辨识度。", "采用大胆表现力视觉；在不牺牲可访问性和真实性的前提下强化色彩、排版和微交互。"],
        ];
  const options: ProjectIntakeOption[] = presets.map(([id, label, description, promptSuffix], index) => ({ id, label, description, promptSuffix, recommended: index === 0 }));
  return {
    summary: `我已经把“${request.slice(0, 80)}”整理成可执行方向。先选一种体验风格，我会把它连同原始需求直接交给 Bob、Alex 和 Ray 开始构建。`,
    assumptions: ["核心功能必须真实可操作，不使用预制 Demo 冒充", "同时覆盖桌面端与移动端，并保留可审计生成记录", ...(reason ? ["需求 Agent 暂时不可用，已使用本地产品规则恢复建议"] : [])].slice(0, 4),
    question: "你更希望第一版采用哪种产品方向？选择后会立即开始真实构建。",
    options,
    source: reason ? "deterministic-recovery" : "model",
  };
}

export async function runIntakeAgent(prompt: string, signal?: AbortSignal, budget = createIntakeBudget()): Promise<AgentModelResult<ProjectIntake>> {
  const startedAt = Date.now();
  const fallback = deterministicProjectIntake(prompt);
  const result = await chat([
    { role: "system", content: "You are Iris, a principal product manager. Before implementation, briefly understand the user's app and offer exactly three materially different product/style directions. Return compact valid JSON only with keys: summary (Chinese string), assumptions (2-4 Chinese strings), question (one Chinese string), options (exactly 3 objects with id, label, description, promptSuffix, recommended). Exactly one option must be recommended. promptSuffix must add concrete functional, visual, accessibility, mobile and edge-case requirements that can be passed directly to coding agents. Never claim code was built. Do not return markdown or reasoning." },
    { role: "user", content: `Original app request:\n${prompt}` },
  ], runtimeInteger("OPENCODE_GO_INTAKE_MAX_TOKENS", 6_000, 1_000, 12_000), budget, signal, undefined, { acceptIncomplete: isCompleteJsonArtifact });
  const parsed = parseAgentJson(result, "Iris 没有返回可解析的需求澄清选项");
  const parsedOptions = arrayObjects(parsed.options).slice(0, 3);
  const options = parsedOptions.length === 3 ? parsedOptions.map((item, index): ProjectIntakeOption => ({
    id: stringValue(item.id, fallback.options[index].id, 32).replace(/[^a-zA-Z0-9_-]/g, "-") || fallback.options[index].id,
    label: stringValue(item.label, fallback.options[index].label, 32),
    description: stringValue(item.description, fallback.options[index].description, 180),
    promptSuffix: stringValue(item.promptSuffix, fallback.options[index].promptSuffix, 800),
    recommended: item.recommended === true,
  })) : fallback.options;
  const recommendedIndex = Math.max(0, options.findIndex((option) => option.recommended));
  options.forEach((option, index) => { option.recommended = index === recommendedIndex; });
  return modelResult({
    summary: stringValue(parsed.summary, fallback.summary, 500),
    assumptions: stringArray(parsed.assumptions, fallback.assumptions, 4),
    question: stringValue(parsed.question, fallback.question, 220),
    options,
    source: "model",
  }, result, startedAt);
}

export type ArchitectureArtifact = {
  summary: string;
  visualDirection: string;
  informationArchitecture: string[];
  stateModel: string[];
  interactionFlow: string[];
  fileResponsibilities: Record<keyof GeneratedFiles, string>;
  testPlan: string[];
  runtime: AppRuntimeBlueprint;
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
  recovery?: { kind: "deterministic"; reason: string };
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
  ], runtimeInteger("OPENCODE_GO_IRIS_MAX_TOKENS", 10_000, 1_000, 20_000), budget, signal, report ? { stage: { agent: "Iris", phase: "requirements:model", label: "Iris 正在形成可验收需求" }, report } : undefined, { acceptIncomplete: isCompleteJsonArtifact });
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
    { role: "system", content: "You are Bob, a senior full-stack architect. Produce a concrete architecture handoff for a vanilla HTML/CSS/JavaScript application running on the Nucleus platform. Return compact valid JSON only with keys: summary, visualDirection, informationArchitecture (array), stateModel (array), interactionFlow (array), fileResponsibilities (object with index.html, styles.css, script.js), testPlan (array), runtime (object). runtime must contain: collections (array of {name,label,access: owner|public-read|public-write,fields:[{name,type:string|number|boolean|date|json,required,maxLength?}]}), authMode (anonymous|account|mixed), backendFunctions (array of {name,method:GET|POST,path,purpose,status:available|external-runner-required}), dependencies ({npm:[],pip:[],system:[],containers:[]}). Prefer the platform data API for durable product data. Declare dependencies honestly; Python, Java, native packages and containers require the external runner. The three browser files MUST remain separate: index.html contains semantic markup only and MUST NOT inline style or script; styles.css contains CSS only; script.js contains JavaScript only. Never recommend an all-in-one document. Make every acceptance criterion implementable and testable. Do not return markdown or reasoning." },
    { role: "user", content: `Original request:\n${prompt}\n\nIris requirements:\n${JSON.stringify(plan)}${currentFiles ? "\n\nAn existing version will be supplied to Alex for a safe iteration." : ""}` },
  ], runtimeInteger("OPENCODE_GO_BOB_MAX_TOKENS", 12_000, 1_000, 24_000), budget, signal, report ? { stage: { agent: "Bob", phase: "architecture:model", label: "Bob 正在设计状态、交互和测试契约" }, report } : undefined, { acceptIncomplete: isCompleteJsonArtifact });
  const parsed = parseAgentJson(result, "Bob 没有返回可解析的架构工件");
  const architecture: ArchitectureArtifact = {
    summary: stringValue(parsed.summary, `以三文件自包含架构实现 ${plan.appName}`, 600),
    visualDirection: stringValue(parsed.visualDirection, plan.design, 500),
    informationArchitecture: stringArray(parsed.informationArchitecture, plan.features, 14),
    stateModel: stringArray(parsed.stateModel, ["单一可预测应用状态", "渲染由状态驱动", "所有用户动作都有明确状态迁移"], 16),
    interactionFlow: stringArray(parsed.interactionFlow, plan.acceptanceCriteria ?? plan.features, 18),
    fileResponsibilities: { ...canonicalFileResponsibilities },
    testPlan: stringArray(parsed.testPlan, plan.testPlan ?? plan.features.map((feature) => `验证：${feature}`), 18),
    runtime: normalizeRuntimeBlueprint(parsed.runtime, prompt, plan),
  };
  return modelResult(architecture, result, startedAt);
}

export function deterministicIrisResult(prompt: string, currentFiles: GeneratedFiles | undefined, reason: string): AgentModelResult<AgentPlan> {
  const plan = planFromPrompt(prompt, Boolean(currentFiles));
  const acceptance = plan.features.map((feature) => `可以在预览中实际验证：${feature}`);
  return recoveredResult({
    ...plan,
    archetype: "interactive-web-app",
    acceptanceCriteria: acceptance,
    risks: ["模型 Provider 暂时不可用，已采用确定性需求契约", "生成代码仍必须通过 Ray 与确定性质量门"],
    testPlan: acceptance.map((item) => `测试：${item}`),
  }, reason);
}

export function deterministicBobResult(prompt: string, plan: AgentPlan, reason: string): AgentModelResult<ArchitectureArtifact> {
  return recoveredResult({
    summary: `以可恢复的三文件浏览器架构实现 ${plan.appName}`,
    visualDirection: plan.design,
    informationArchitecture: plan.features.slice(0, 14),
    stateModel: ["单一应用状态作为事实源", "所有输入驱动显式状态迁移", "渲染只读取当前状态", "开始、暂停、完成和重置均可恢复"],
    interactionFlow: (plan.acceptanceCriteria ?? plan.features).slice(0, 18),
    fileResponsibilities: { ...canonicalFileResponsibilities },
    testPlan: (plan.testPlan ?? plan.features.map((feature) => `验证：${feature}`)).slice(0, 18),
    runtime: normalizeRuntimeBlueprint(undefined, prompt, plan),
  }, reason);
}

export function deterministicRayResult(prompt: string, plan: AgentPlan, files: GeneratedFiles, reason: string): AgentModelResult<RayReviewArtifact> {
  const deterministic = reviewGeneratedApp(files);
  const productChecks = reviewProductContract(prompt, files);
  const failedChecks = [...deterministic.checks, ...productChecks].filter((check) => check.severity === "error");
  return recoveredResult({
    passed: deterministic.passed && productChecks.every((check) => check.severity !== "error"),
    summary: failedChecks.length ? `确定性审查发现 ${failedChecks.length} 个阻断问题` : `${deterministic.summary}；模型 Reviewer 不可用，采用保守确定性审查`,
    functionalChecks: (plan.acceptanceCriteria ?? plan.features).slice(0, 20).map((name) => ({ name, passed: failedChecks.length === 0, evidence: failedChecks.length ? "存在阻断性确定性检查，需进入修复" : "通用质量门及应用类型契约均已通过" })),
    issues: qualityIssuesFromChecks([...deterministic.checks, ...productChecks]),
    deterministic,
    productChecks,
  }, reason);
}

export async function runAlexFileAgent(path: keyof GeneratedFiles, prompt: string, plan: AgentPlan, architecture: ArchitectureArtifact, files: Partial<GeneratedFiles>, currentFiles: GeneratedFiles | undefined, signal: AbortSignal | undefined, budget: ModelBudget, report?: (event: GenerationProgress) => void, agentOptions: { models?: string[] } = {}): Promise<AgentModelResult<string>> {
  const startedAt = Date.now();
  const availableFiles = { ...(currentFiles ?? {}), ...files };
  const allowedContextPaths: Array<keyof GeneratedFiles> = path === "index.html"
    ? ["index.html"]
    : path === "styles.css"
      ? ["index.html", "styles.css"]
      : ["index.html", "styles.css", "script.js"];
  const context = allowedContextPaths
    .filter((name) => typeof availableFiles[name] === "string")
    .map((name) => `--- ${name} (reference only; do not reproduce) ---\n${availableFiles[name]}`)
    .join("\n\n");
  const scopedArchitecture = path === "script.js" ? architecture : {
    summary: architecture.summary,
    visualDirection: architecture.visualDirection,
    informationArchitecture: architecture.informationArchitecture,
    ...(path === "styles.css" ? { stateModel: architecture.stateModel } : {}),
    fileResponsibility: architecture.fileResponsibilities[path],
  };
  const requestContext = path === "script.js"
    ? `Original request:\n${prompt}`
    : `Project goal:\n${plan.appName}: ${plan.summary}\nRequired features:\n${plan.features.map((feature) => `- ${feature}`).join("\n")}`;
  const pathRule = path === "index.html"
    ? "Return complete semantic HTML and head metadata. Do not include any style element, script element, or stylesheet link: the platform injects styles.css and script.js automatically. Do not implement CSS or JavaScript in this response. Every visible primary control needs a stable id or data attribute. Keep the file compact and normally under 7,000 characters."
    : path === "styles.css"
      ? "Return complete responsive CSS only. Do not output HTML or JavaScript. Include desktop and mobile layouts, clear focus-visible states, reduced-motion support, and the required empty/error/active states. Prefer reusable selectors over decorative repetition; omit long comments and keep the file normally under 10,000 characters."
      : "Return complete executable vanilla JavaScript only. Do not output HTML or CSS. Implement every acceptance criterion and interaction, robust state transitions, keyboard and touch behavior where relevant, and defensive DOM access. Never declare the same function or identifier twice in one scope; if using selector helpers, use distinct singular/plural names such as $ and $$. For typing/speed apps, clamp the elapsed-time denominator to at least one full second before calculating WPM/CPM so paste or automation cannot produce Infinity or absurd millions. For finance/list apps, explicitly toggle the empty state whenever records change and recompute every aggregate from current state. For games, wire start, pause/resume, reset, collision and game-over transitions to visible controls and keyboard/touch input. The platform injects window.nucleus.auth and async window.nucleus.data.list/create/update/remove; when Bob declares runtime collections, use that API for durable product records and reserve localStorage for device-local preferences or an offline fallback. No imports or external libraries. Prefer small reusable functions, omit long comments, and keep the file normally under 24,000 characters.";
  const result = await chat([
    { role: "system", content: `You are Alex, an elite implementation engineer working in a multi-agent pipeline. Your current and ONLY responsibility is ${path}; separate calls create the other two files. Generate EXACTLY ONE production-ready file: ${path}. ${pathRule} Completeness is more important than ornamental volume: implement every required behavior, then close the code fence early instead of expanding optional decoration. Any inline implementation or content belonging to another file is a protocol failure, even if the project request asks for a complete application. Your entire response must contain exactly one markdown code block with the exact opening line \`\`\`${languageFor(path)}{path=${path}} and one closing fence. Do not include reasoning, summaries, prefaces, or any other file. Stop immediately after the closing fence. Never put markdown fences inside the file.` },
    { role: "user", content: `${requestContext}\n\nIris contract:\n${JSON.stringify(plan)}\n\nScoped Bob handoff for ${path}:\n${JSON.stringify(scopedArchitecture)}${context ? `\n\nFiles available for cross-file consistency:\n${context}` : ""}\n\nFINAL DELIVERABLE FOR THIS CALL: ${path} ONLY. Other agents own the other files. Do not output or re-create any other path.` },
  ], runtimeInteger(`OPENCODE_GO_${path === "index.html" ? "HTML" : path === "styles.css" ? "CSS" : "JS"}_MAX_TOKENS`, path === "index.html" ? 8_000 : path === "styles.css" ? 12_000 : 24_000, 2_000, 32_000), budget, signal, report ? { stage: { agent: "Alex", phase: `implementation:${path}`, label: `Alex 正在生成 ${path}` }, report } : undefined, { ...codeChatOptions(), acceptIncomplete: (content) => isCompleteSingleFileArtifact(path, content), ...(agentOptions.models ? { models: agentOptions.models } : {}) });
  const content = normalizeArtifactContent(path, extractSingleFile(path, result.content));
  if (content.length < 40) throw new AgentOutputError(`${path} 输出过短，未形成可用工件`, result);
  if (content.length > 120_000) throw new AgentOutputError(`${path} 超过 120KB 安全上限`, result);
  const violation = artifactProtocolViolation(path, content);
  if (violation) throw new AgentOutputError(violation, result);
  return modelResult(content, result, startedAt);
}

export async function runAlexFileRaceAgent(path: keyof GeneratedFiles, prompt: string, plan: AgentPlan, architecture: ArchitectureArtifact, files: Partial<GeneratedFiles>, currentFiles: GeneratedFiles | undefined, signal: AbortSignal | undefined, budgetFactory: () => ModelBudget, report?: (event: GenerationProgress) => void): Promise<{
  result: AgentModelResult<string>;
  candidates: Array<{ model: string; artifact: string; score: number; selected: boolean }>;
}> {
  const startedAt = Date.now();
  const models = activeCodeModels().slice(0, 3);
  if (models.length < 2) {
    const result = await runAlexFileAgent(path, prompt, plan, architecture, files, currentFiles, signal, budgetFactory(), report, { models });
    return { result, candidates: [{ model: result.model, artifact: result.artifact, score: scoreFileCandidate(path, result.artifact), selected: true }] };
  }
  const settled = await Promise.all(models.map(async (model) => {
    try {
      const result = await runAlexFileAgent(path, prompt, plan, architecture, files, currentFiles, signal, budgetFactory(), report ? (event) => report({ ...event, label: `${model} · ${event.label}` }) : undefined, { models: [model] });
      return { model, result, error: null as unknown };
    } catch (error) {
      return { model, result: null, error };
    }
  }));
  const successes = settled.filter((item): item is { model: string; result: AgentModelResult<string>; error: null } => Boolean(item.result));
  if (successes.length === 0) throw settled[0]?.error instanceof Error ? settled[0].error : new Error(`Race Mode 没有模型成功生成 ${path}`);
  const scored = successes.map((item) => ({ ...item, score: scoreFileCandidate(path, item.result.artifact) })).sort((a, b) => b.score - a.score || b.result.artifact.length - a.result.artifact.length);
  const winner = scored[0];
  const failedAttempts = settled.flatMap((item) => item.result ? [] : attemptsFromAgentError(item.error));
  const attempts = [...successes.flatMap((item) => item.result.attempts), ...failedAttempts];
  const result: AgentModelResult<string> = {
    ...winner.result,
    durationMs: Date.now() - startedAt,
    modelCalls: attempts.length,
    usage: addUsage(...attempts.map((attempt) => attempt.usage)),
    attempts,
  };
  return {
    result,
    candidates: scored.map((item) => ({ model: item.result.model, artifact: item.result.artifact, score: item.score, selected: item === winner })),
  };
}

export async function runRayReviewAgent(prompt: string, plan: AgentPlan, architecture: ArchitectureArtifact, files: GeneratedFiles, signal: AbortSignal | undefined, budget: ModelBudget, report?: (event: GenerationProgress) => void): Promise<AgentModelResult<RayReviewArtifact>> {
  const startedAt = Date.now();
  const deterministic = reviewGeneratedApp(files);
  const productChecks = reviewProductContract(prompt, files);
  const result = await chat([
    { role: "system", content: "You are Ray, a skeptical senior QA and code reviewer. Inspect the complete three-file application against every acceptance criterion and test plan. Explicitly trace state transitions and edge cases: finance/list empty states must disappear after records are added; typing WPM/CPM must remain finite and plausible for instant paste/automation; games must wire start, pause/resume, reset, collision and game over to real controls. Return compact valid JSON only: passed (boolean), summary (string), functionalChecks (array of {name,passed,evidence}), issues (array of {severity: warning|error,file: index.html|styles.css|script.js|application,detail}). Mark error only for a concrete functional, runtime, safety, or acceptance failure. Do not invent missing behavior when code evidence proves it exists. Do not return markdown or reasoning." },
    { role: "user", content: `Original request:\n${prompt}\n\nIris contract:\n${JSON.stringify(plan)}\n\nBob architecture:\n${JSON.stringify(architecture)}\n\nDeterministic checks:\n${JSON.stringify(deterministic)}\n\nArchetype contract checks:\n${JSON.stringify(productChecks)}\n\nFiles:\n--- index.html ---\n${files["index.html"]}\n--- styles.css ---\n${files["styles.css"]}\n--- script.js ---\n${files["script.js"]}` },
  ], runtimeInteger("OPENCODE_GO_RAY_MAX_TOKENS", 12_000, 1_500, 24_000), budget, signal, report ? { stage: { agent: "Ray", phase: "quality:model", label: "Ray 正在核对验收标准和代码证据" }, report } : undefined, { acceptIncomplete: isCompleteJsonArtifact });
  const parsed = parseAgentJson(result, "Ray 没有返回可解析的质量工件");
  const functionalChecks = arrayObjects(parsed.functionalChecks).slice(0, 24).map((item, index) => ({
    name: stringValue(item.name, `功能检查 ${index + 1}`, 180),
    passed: item.passed !== false,
    evidence: stringValue(item.evidence, "已检查实现代码", 400),
  }));
  const modelIssues = arrayObjects(parsed.issues).slice(0, 16).map((item) => ({
    severity: item.severity === "error" ? "error" as const : "warning" as const,
    file: (["index.html", "styles.css", "script.js"] as const).includes(item.file as keyof GeneratedFiles) ? item.file as keyof GeneratedFiles : "application" as const,
    detail: stringValue(item.detail, "需要人工复核", 500),
  }));
  const groundedIssues = qualityIssuesFromChecks([...deterministic.checks, ...productChecks]);
  const issues = [...groundedIssues, ...modelIssues].filter((issue, index, all) =>
    all.findIndex((candidate) => candidate.file === issue.file && candidate.detail === issue.detail) === index,
  ).slice(0, 24);
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
  const requiredFiles = requiredQualityIssueFiles(review.issues);
  const result = await chat([
    { role: "system", content: "You are Ray acting as the repair engineer. Fix every concrete error in the QA report while preserving working behavior. Every file named by an error must be returned as a complete changed file; do not substitute an unrelated file. Return only the complete changed files as markdown code blocks with exact {path=index.html}, {path=styles.css}, or {path=script.js} opening-line metadata. Do not return unchanged files, explanations, summaries, or JSON. Never put markdown fences inside a file." },
    { role: "user", content: `Original request:\n${prompt}\n\nIris contract:\n${JSON.stringify(plan)}\n\nBob architecture:\n${JSON.stringify(architecture)}\n\nQA report:\n${JSON.stringify(review)}\n\nMandatory changed files named by blocking evidence: ${requiredFiles.length ? requiredFiles.join(", ") : "none explicitly named; infer the minimum correct set"}\n\nCurrent files:\n--- index.html ---\n${files["index.html"]}\n--- styles.css ---\n${files["styles.css"]}\n--- script.js ---\n${files["script.js"]}` },
  ], runtimeInteger("OPENCODE_GO_REPAIR_MAX_TOKENS", 24_000, 2_000, 32_000), budget, signal, report ? { stage: { agent: "Ray", phase: "quality:repair", label: "Ray 正在按失败证据修复工件" }, report } : undefined, { ...codeChatOptions(), acceptIncomplete: isCompleteRepairArtifact });
  const extracted = extractGeneratedFiles(result.content);
  if (Object.keys(extracted).length === 0) throw new AgentOutputError("Ray 没有返回可解析的修复文件", result);
  const changed: Partial<GeneratedFiles> = {};
  for (const [path, rawContent] of Object.entries(extracted) as Array<[keyof GeneratedFiles, string]>) {
    const content = normalizeArtifactContent(path, rawContent);
    const violation = artifactProtocolViolation(path, content);
    if (violation) throw new AgentOutputError(`Ray 修复工件无效：${violation}`, result);
    changed[path] = content;
  }
  const missingRequiredFiles = requiredFiles.filter((path) => !(path in changed));
  if (missingRequiredFiles.length) {
    throw new AgentOutputError(`Ray 没有返回阻断问题要求修复的文件：${missingRequiredFiles.join("、")}`, result);
  }
  return modelResult(changed, result, startedAt);
}

function modelResult<T>(artifact: T, result: GatewayChatResult, startedAt: number): AgentModelResult<T> {
  return { artifact, raw: result.content, usage: result.usage, durationMs: Date.now() - startedAt, modelCalls: result.calls, model: result.model, attempts: result.attempts };
}

function recoveredResult<T>(artifact: T, reason: string): AgentModelResult<T> {
  return { artifact, raw: "", usage: emptyUsage(), durationMs: 0, modelCalls: 0, model: "Nucleus deterministic recovery", attempts: [], recovery: { kind: "deterministic", reason } };
}

function attemptsFromAgentError(error: unknown): ModelAttempt[] {
  if (error instanceof AgentOutputError) return error.result.attempts;
  if (error instanceof ModelGatewayError) return error.attempts;
  return [];
}

function parseAgentJson(result: GatewayChatResult, message: string): Record<string, unknown> {
  try {
    return parseStructuredJsonObject(result.content);
  } catch {
    throw new AgentOutputError(message, result);
  }
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
  ], 3600, budget, signal, reportProgress ? { stage: { agent: "Alex", phase: "implementation:initial", label: "正在实时生成页面、样式和交互" }, report: reportProgress } : undefined, { ...codeChatOptions(), acceptIncomplete: isCompleteThreeFileArtifact });
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
      ], 2200, budget, signal, reportProgress ? { stage: { agent: "Alex", phase: "implementation:missing", label: `正在补齐 ${missing.join("、")}` }, report: reportProgress } : undefined, codeChatOptions());
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
    ], 2600, budget, signal, reportProgress ? { stage: { agent: "Ray", phase: "quality:repair", label: "正在实时修复质量门问题" }, report: reportProgress } : undefined, codeChatOptions());
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
