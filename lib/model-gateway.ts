import { addUsage, emptyUsage, normalizeUsage } from "./usage";
import type { ModelUsage } from "./types";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ModelAttemptStatus = "success" | "empty" | "http_error" | "timeout" | "network_error" | "budget_exceeded";

export type ModelAttempt = {
  model: string;
  status: ModelAttemptStatus;
  durationMs: number;
  statusCode: number | null;
  usage: ModelUsage;
  error: string | null;
};

export type ModelBudget = {
  maxCalls: number;
  maxTotalTokens: number;
  deadlineAt: number;
  calls: number;
  usage: ModelUsage;
  modelsUsed: string[];
};

export type GatewayChatResult = {
  content: string;
  usage: ModelUsage;
  durationMs: number;
  calls: number;
  model: string;
  attempts: ModelAttempt[];
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class ModelGatewayError extends Error {
  constructor(message: string, readonly attempts: ModelAttempt[], readonly kind: "provider" | "budget") {
    super(message);
    this.name = "ModelGatewayError";
  }
}

export function createModelBudget(options: { maxCalls: number; maxTotalTokens: number; maxDurationMs: number; now?: number }): ModelBudget {
  const now = options.now ?? Date.now();
  return {
    maxCalls: clampInteger(options.maxCalls, 1, 20),
    maxTotalTokens: clampInteger(options.maxTotalTokens, 1_000, 200_000),
    deadlineAt: now + clampInteger(options.maxDurationMs, 5_000, 290_000),
    calls: 0,
    usage: emptyUsage(),
    modelsUsed: [],
  };
}

export async function requestChat(input: {
  baseUrl: string;
  apiKey: string;
  models: string[];
  messages: ChatMessage[];
  maxTokens: number;
  requestTimeoutMs: number;
  budget: ModelBudget;
  signal?: AbortSignal;
  fetcher?: FetchLike;
}): Promise<GatewayChatResult> {
  const startedAt = Date.now();
  const attempts: ModelAttempt[] = [];
  let chatUsage = emptyUsage();
  let lastError = "The provider returned no usable content";
  const fetcher = input.fetcher ?? fetch;
  const models = [...new Set(input.models.map((model) => model.trim()).filter(Boolean))];
  if (models.length === 0) throw new ModelGatewayError("No model is configured", attempts, "provider");

  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const model = models[modelIndex];
    for (let emptyAttempt = 0; emptyAttempt < 2; emptyAttempt++) {
      reserveCall(input.budget, model, attempts);
      input.signal?.throwIfAborted();
      const attemptStartedAt = Date.now();
      const remainingMs = input.budget.deadlineAt - attemptStartedAt;
      if (remainingMs <= 0) throw new ModelGatewayError("The generation time budget is exhausted", attempts, "budget");
      const timeoutController = new AbortController();
      const timeoutMs = Math.max(1, Math.min(input.requestTimeoutMs, remainingMs));
      const timer = setTimeout(() => timeoutController.abort(new DOMException("Model request timed out", "TimeoutError")), timeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeoutController.signal]) : timeoutController.signal;
      const messages = emptyAttempt === 0
        ? input.messages
        : [...input.messages, { role: "user" as const, content: "The previous completion was empty. Output the requested final answer immediately, with no reasoning preface." }];

      try {
        const response = await fetcher(`${input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
          body: JSON.stringify({ model, messages, max_tokens: input.maxTokens, stream: false }),
          signal,
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 180);
          lastError = `Model ${model} failed (${response.status}): ${detail}`;
          attempts.push(attempt(model, "http_error", attemptStartedAt, response.status, emptyUsage(), detail));
          if (response.status === 401 || response.status === 429 || modelIndex === models.length - 1) {
            throw new ModelGatewayError(lastError, attempts, "provider");
          }
          break;
        }

        const data = await response.json() as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>; usage?: unknown };
        const usage = normalizeUsage(data.usage);
        chatUsage = addUsage(chatUsage, usage);
        input.budget.usage = addUsage(input.budget.usage, usage);
        const content = usableContent(data.choices?.[0]?.message);
        attempts.push(attempt(model, content ? "success" : "empty", attemptStartedAt, response.status, usage, content ? null : "Empty model response"));
        if (input.budget.usage.totalTokens > input.budget.maxTotalTokens) {
          attempts[attempts.length - 1] = { ...attempts[attempts.length - 1], status: "budget_exceeded", error: "Token budget exhausted" };
          throw new ModelGatewayError(`Model usage exceeded the ${input.budget.maxTotalTokens} token budget`, attempts, "budget");
        }
        if (content) return { content, usage: chatUsage, durationMs: Date.now() - startedAt, calls: attempts.length, model, attempts };
        lastError = `Model ${model} returned empty content`;
      } catch (error) {
        if (error instanceof ModelGatewayError) throw error;
        if (input.signal?.aborted) throw error;
        const timedOut = timeoutController.signal.aborted;
        const detail = error instanceof Error ? error.message : "Network request failed";
        lastError = timedOut ? `Model ${model} timed out after ${timeoutMs}ms` : `Model ${model} network request failed: ${detail}`;
        attempts.push(attempt(model, timedOut ? "timeout" : "network_error", attemptStartedAt, null, emptyUsage(), detail));
        if (modelIndex === models.length - 1) throw new ModelGatewayError(lastError, attempts, "provider");
        break;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new ModelGatewayError(lastError, attempts, "provider");
}

function reserveCall(budget: ModelBudget, model: string, attempts: ModelAttempt[]) {
  if (Date.now() >= budget.deadlineAt) throw new ModelGatewayError("The generation time budget is exhausted", attempts, "budget");
  if (budget.calls >= budget.maxCalls) throw new ModelGatewayError(`The generation reached its ${budget.maxCalls}-call budget`, attempts, "budget");
  budget.calls += 1;
  if (!budget.modelsUsed.includes(model)) budget.modelsUsed.push(model);
}

function usableContent(message?: { content?: string; reasoning_content?: string }): string {
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  if (content) return content;
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
  return reasoning.includes("```") || reasoning.includes("<summary>") || /^\{[\s\S]*\}$/.test(reasoning) ? reasoning : "";
}

function attempt(model: string, status: ModelAttemptStatus, startedAt: number, statusCode: number | null, usage: ModelUsage, error: string | null): ModelAttempt {
  return { model, status, durationMs: Date.now() - startedAt, statusCode, usage, error };
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.floor(value) : min));
}
