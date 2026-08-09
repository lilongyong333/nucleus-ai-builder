import { env } from "cloudflare:workers";
import { createModelBudget, requestChat, type ChatMessage, type GatewayChatResult, type ModelBudget } from "./model-gateway";
import { extractGeneratedFiles, parseGeneratedReply } from "./parser";
import { planFromPrompt } from "./planner";
import { qualityRepairBrief, reviewGeneratedApp } from "./quality";
import { addUsage, emptyUsage } from "./usage";
import type { AgentPlan, AppQualityReport, GeneratedFiles, ModelUsage } from "./types";

function runtimeValue(name: string, fallback = ""): string {
  const cloud = env as unknown as Record<string, unknown>;
  const value = cloud[name] ?? process.env[name];
  return typeof value === "string" && value ? value : fallback;
}

export function activeModel(): string {
  return runtimeValue("OPENCODE_GO_MODEL", "glm-5.2");
}

export function activeModels(): string[] {
  return [...new Set([activeModel(), runtimeValue("OPENCODE_GO_FALLBACK_MODEL", "qwen3.5-plus")].filter(Boolean))];
}

function runtimeInteger(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(runtimeValue(name, String(fallback)));
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? Math.floor(parsed) : fallback));
}

export function createGenerationBudget(): ModelBudget {
  return createModelBudget({
    maxCalls: runtimeInteger("OPENCODE_GO_MAX_MODEL_CALLS", 8, 1, 20),
    maxTotalTokens: runtimeInteger("OPENCODE_GO_MAX_TOTAL_TOKENS", 50_000, 1_000, 200_000),
    maxDurationMs: runtimeInteger("OPENCODE_GO_MAX_DURATION_MS", 240_000, 5_000, 290_000),
  });
}

async function chat(messages: ChatMessage[], maxTokens: number, budget: ModelBudget, signal?: AbortSignal): Promise<GatewayChatResult> {
  const apiKey = runtimeValue("OPENCODE_GO_API_KEY");
  if (!apiKey) throw new Error("站点还没有配置 OpenCode Go API Key");
  return requestChat({
    baseUrl: runtimeValue("OPENCODE_GO_BASE_URL", "https://opencode.ai/zen/go/v1"),
    apiKey,
    models: activeModels(),
    messages,
    maxTokens,
    requestTimeoutMs: runtimeInteger("OPENCODE_GO_REQUEST_TIMEOUT_MS", 55_000, 5_000, 90_000),
    budget,
    signal,
  });
}

export async function createPlan(prompt: string, currentFiles?: GeneratedFiles, signal?: AbortSignal, budget = createGenerationBudget()): Promise<{ plan: AgentPlan; usage: ModelUsage; durationMs: number; modelCalls: number; model: string; usedFallback: boolean }> {
  void budget;
  const startedAt = Date.now();
  signal?.throwIfAborted();
  return { plan: planFromPrompt(prompt, Boolean(currentFiles)), usage: emptyUsage(), durationMs: Date.now() - startedAt, modelCalls: 0, model: "Iris deterministic SOP", usedFallback: false };
}

export async function buildApp(prompt: string, plan: AgentPlan, currentFiles?: GeneratedFiles, signal?: AbortSignal, budget = createGenerationBudget()): Promise<{ files: GeneratedFiles; summary: string; quality: AppQualityReport; usage: ModelUsage; durationMs: number; modelCalls: number; repairCount: number; model: string; models: string[]; usedFallback: boolean }> {
  const startedAt = Date.now();
  let usage = emptyUsage();
  let modelCalls = 0;
  let repairCount = 0;
  const models = new Set<string>();
  const existing = currentFiles ? `\nExisting files to improve:\n${Object.entries(currentFiles).map(([path, content]) => `--- ${path} ---\n${content}`).join("\n")}` : "";
  const initial = await chat([
    { role: "system", content: `You are Alex, an elite frontend engineer. Do not reveal reasoning; start the final artifact immediately. Build a polished, fully interactive browser app with no build step. Output exactly one short Chinese summary wrapped in <summary>...</summary>, followed by exactly three markdown code blocks whose opening lines are:\n\`\`\`html{path=index.html}\n\`\`\`css{path=styles.css}\n\`\`\`js{path=script.js}\nRules: use semantic HTML; responsive CSS; vanilla JavaScript; no external libraries; no SVG; no placeholder buttons; every visible primary control must work; keep each file under 60KB; do not include style or script tags in index.html; index.html must contain complete body markup. Never place markdown fences inside a generated file.` },
    { role: "user", content: `Request: ${prompt}\nPlan: ${JSON.stringify(plan)}${existing}` },
  ], 8000, budget, signal);
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
      ], 5000, budget, signal);
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
    ], 6000, budget, signal);
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
