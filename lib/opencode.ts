import { env } from "cloudflare:workers";
import { parseGeneratedReply } from "./parser";
import type { AgentPlan, GeneratedFiles } from "./types";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function runtimeValue(name: string, fallback = ""): string {
  const cloud = env as unknown as Record<string, unknown>;
  const value = cloud[name] ?? process.env[name];
  return typeof value === "string" && value ? value : fallback;
}

export function activeModel(): string {
  return runtimeValue("OPENCODE_GO_MODEL", "glm-5.2");
}

async function chat(messages: ChatMessage[], maxTokens: number): Promise<string> {
  const apiKey = runtimeValue("OPENCODE_GO_API_KEY");
  if (!apiKey) throw new Error("站点还没有配置 OpenCode Go API Key");
  const baseUrl = runtimeValue("OPENCODE_GO_BASE_URL", "https://opencode.ai/zen/go/v1").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: activeModel(), messages, max_tokens: maxTokens, stream: false }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`模型调用失败（${response.status}）：${detail.slice(0, 180)}`);
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型返回了空内容");
  return content;
}

function parseObject<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 对象");
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

export async function createPlan(prompt: string, currentFiles?: GeneratedFiles): Promise<AgentPlan> {
  const context = currentFiles ? "This is an iteration on an existing app." : "This is a new app.";
  const raw = await chat([
    { role: "system", content: "You are Iris, a concise senior product designer. Return JSON only, never markdown." },
    { role: "user", content: `${context}\nUser request: ${prompt}\nReturn exactly {"appName":"short name","summary":"one sentence in Chinese","features":["3-5 concrete features in Chinese"],"design":"visual direction in Chinese"}.` },
  ], 900);
  const value = parseObject<Partial<AgentPlan>>(raw);
  return {
    appName: String(value.appName || "Nucleus App").slice(0, 48),
    summary: String(value.summary || prompt).slice(0, 240),
    features: Array.isArray(value.features) ? value.features.map(String).slice(0, 6) : ["核心交互"],
    design: String(value.design || "简洁、清晰、响应式").slice(0, 240),
  };
}

export async function buildApp(prompt: string, plan: AgentPlan, currentFiles?: GeneratedFiles): Promise<{ files: GeneratedFiles; summary: string }> {
  const existing = currentFiles ? `\nExisting files to improve:\n${Object.entries(currentFiles).map(([path, content]) => `--- ${path} ---\n${content}`).join("\n")}` : "";
  const raw = await chat([
    { role: "system", content: `You are Alex, an elite frontend engineer. Build a polished, fully interactive browser app with no build step. Output exactly one short Chinese summary wrapped in <summary>...</summary>, followed by exactly three markdown code blocks whose opening lines are:\n\`\`\`html{path=index.html}\n\`\`\`css{path=styles.css}\n\`\`\`js{path=script.js}\nRules: use semantic HTML; responsive CSS; vanilla JavaScript; no external libraries; no SVG; no placeholder buttons; every visible primary control must work; keep each file under 60KB; do not include style or script tags in index.html; index.html must contain complete body markup. Never place markdown fences inside a generated file.` },
    { role: "user", content: `Request: ${prompt}\nPlan: ${JSON.stringify(plan)}${existing}` },
  ], 6000);
  return parseGeneratedReply(raw, `完成 ${plan.appName}`, currentFiles);
}
