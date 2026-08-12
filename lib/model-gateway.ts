import { addUsage, emptyUsage, normalizeUsage } from "./usage";
import type { ModelUsage } from "./types";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ModelAttemptStatus = "success" | "recovered" | "empty" | "incomplete" | "http_error" | "timeout" | "network_error" | "budget_exceeded" | "cancelled";

export type ModelAttempt = {
  model: string;
  status: ModelAttemptStatus;
  durationMs: number;
  firstTokenMs: number | null;
  outputChars: number;
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

export type ModelStreamUpdate = {
  model: string;
  delta: string;
  totalChars: number;
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type ModelProtocol = "chat-completions" | "responses";
type NormalizedModelResponse = {
  content: string;
  reasoningContent: string;
  usage: unknown;
  completed: boolean;
  finishReason: string | null;
  streamError: unknown | null;
};

export class ModelGatewayError extends Error {
  constructor(message: string, readonly attempts: ModelAttempt[], readonly kind: "provider" | "budget") {
    super(message);
    this.name = "ModelGatewayError";
  }
}

export function createModelBudget(options: { maxCalls: number; maxTotalTokens: number; maxDurationMs: number; now?: number }): ModelBudget {
  const now = options.now ?? Date.now();
  return {
    maxCalls: clampInteger(options.maxCalls, 1, 40),
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
  firstTokenTimeoutMs?: number;
  fallbackReserveMs?: number;
  emptyRetriesPerModel?: number;
  budget: ModelBudget;
  signal?: AbortSignal;
  fetcher?: FetchLike;
  onDelta?: (update: ModelStreamUpdate) => void;
  acceptIncomplete?: (content: string) => boolean;
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
    const maxAttemptsForModel = 1 + clampInteger(input.emptyRetriesPerModel ?? 0, 0, 1);
    for (let emptyAttempt = 0; emptyAttempt < maxAttemptsForModel; emptyAttempt++) {
      reserveCall(input.budget, model, attempts);
      input.signal?.throwIfAborted();
      const attemptStartedAt = Date.now();
      const remainingMs = input.budget.deadlineAt - attemptStartedAt;
      if (remainingMs <= 0) throw new ModelGatewayError("The generation time budget is exhausted", attempts, "budget");
      const timeoutController = new AbortController();
      const reserveForFallback = modelIndex < models.length - 1 ? Math.min(input.fallbackReserveMs ?? 16_000, Math.max(0, remainingMs - 1_000)) : 0;
      const timeoutMs = Math.max(1, Math.min(input.requestTimeoutMs, remainingMs - reserveForFallback));
      const timer = setTimeout(() => timeoutController.abort(new DOMException("Model request timed out", "TimeoutError")), timeoutMs);
      const firstTokenController = new AbortController();
      const firstTokenTimeoutMs = Math.max(1, Math.min(input.firstTokenTimeoutMs ?? timeoutMs, timeoutMs));
      const firstTokenTimer = setTimeout(
        () => firstTokenController.abort(new DOMException("Model did not return content before the first-token deadline", "TimeoutError")),
        firstTokenTimeoutMs,
      );
      const requestSignals = [timeoutController.signal, firstTokenController.signal, ...(input.signal ? [input.signal] : [])];
      const signal = AbortSignal.any(requestSignals);
      let firstTokenMs: number | null = null;
      let outputChars = 0;
      const reportDelta = (update: ModelStreamUpdate) => {
        if (firstTokenMs === null && update.delta.length > 0) {
          firstTokenMs = Date.now() - attemptStartedAt;
          clearTimeout(firstTokenTimer);
        }
        outputChars = update.totalChars;
        input.onDelta?.(update);
      };
      const messages = emptyAttempt === 0
        ? input.messages
        : [...input.messages, { role: "user" as const, content: "The previous completion was empty. Output the requested final answer immediately, with no reasoning preface." }];
      const protocol = protocolForModel(model);

      try {
        const response = await fetcher(`${input.baseUrl.replace(/\/$/, "")}/${protocol === "responses" ? "responses" : "chat/completions"}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
          body: JSON.stringify(protocol === "responses"
            ? { model, input: messages, max_output_tokens: input.maxTokens, stream: true }
            : { model, messages, max_tokens: input.maxTokens, stream: true, stream_options: { include_usage: true } }),
          signal,
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 180);
          lastError = `Model ${model} failed (${response.status}): ${detail}`;
          attempts.push(attempt(model, "http_error", attemptStartedAt, firstTokenMs, outputChars, response.status, emptyUsage(), detail));
          if (response.status === 401 || response.status === 429 || modelIndex === models.length - 1) {
            throw new ModelGatewayError(lastError, attempts, "provider");
          }
          break;
        }

        const data = protocol === "responses"
          ? await readResponsesResponse(response, model, reportDelta)
          : await readChatResponse(response, model, reportDelta);
        const usage = normalizeUsage(data.usage);
        chatUsage = addUsage(chatUsage, usage);
        input.budget.usage = addUsage(input.budget.usage, usage);
        const content = usableContent({ content: data.content, reasoning_content: data.reasoningContent });
        if (input.signal?.aborted) throw data.streamError ?? input.signal.reason ?? new DOMException("Model request cancelled", "AbortError");
        const artifactRecovered = Boolean(content)
          && !data.completed
          && data.finishReason === null
          && safelyAcceptIncomplete(input.acceptIncomplete, content);
        const completed = Boolean(content) && (data.completed || artifactRecovered);
        const firstTokenTimedOut = firstTokenController.signal.aborted;
        const streamTimedOut = timeoutController.signal.aborted || firstTokenTimedOut;
        const streamErrorDetail = data.streamError instanceof Error ? data.streamError.message : null;
        const completionError = artifactRecovered
          ? `Recovered a structurally complete artifact after ${streamTimedOut ? "the stream timed out" : "the provider omitted its terminal event"}`
          : content
            ? `Incomplete model stream${data.finishReason ? ` (finish_reason=${data.finishReason})` : streamTimedOut ? " (request timed out)" : " (missing terminal event)"}${streamErrorDetail ? `: ${streamErrorDetail}` : ""}`
            : streamTimedOut
              ? firstTokenTimedOut
                ? `Model returned no usable content within ${firstTokenTimeoutMs}ms`
                : "Model request timed out before a usable artifact was completed"
              : streamErrorDetail ?? "Empty model response";
        const status: ModelAttemptStatus = completed
          ? artifactRecovered ? "recovered" : "success"
          : streamTimedOut
            ? "timeout"
            : data.streamError
              ? "network_error"
              : content
                ? "incomplete"
                : "empty";
        attempts.push(attempt(model, status, attemptStartedAt, firstTokenMs, outputChars, response.status, usage, completed && !artifactRecovered ? null : completionError));
        if (input.budget.usage.totalTokens > input.budget.maxTotalTokens) {
          attempts[attempts.length - 1] = { ...attempts[attempts.length - 1], status: "budget_exceeded", error: "Token budget exhausted" };
          throw new ModelGatewayError(`Model usage exceeded the ${input.budget.maxTotalTokens} token budget`, attempts, "budget");
        }
        if (completed) return { content, usage: chatUsage, durationMs: Date.now() - startedAt, calls: attempts.length, model, attempts };
        lastError = content ? `Model ${model} returned an incomplete stream` : `Model ${model} returned empty content`;
      } catch (error) {
        if (error instanceof ModelGatewayError) throw error;
        if (input.signal?.aborted) {
          const detail = error instanceof Error ? error.message : "Model request cancelled";
          attempts.push(attempt(model, "cancelled", attemptStartedAt, firstTokenMs, outputChars, null, emptyUsage(), detail));
          throw new ModelGatewayError("The model request was cancelled", attempts, "provider");
        }
        const firstTokenTimedOut = firstTokenController.signal.aborted;
        const timedOut = timeoutController.signal.aborted || firstTokenTimedOut;
        const detail = error instanceof Error ? error.message : "Network request failed";
        lastError = timedOut
          ? firstTokenTimedOut
            ? `Model ${model} returned no usable content within ${firstTokenTimeoutMs}ms`
            : `Model ${model} timed out after ${timeoutMs}ms`
          : `Model ${model} network request failed: ${detail}`;
        attempts.push(attempt(model, timedOut ? "timeout" : "network_error", attemptStartedAt, firstTokenMs, outputChars, null, emptyUsage(), detail));
        if (modelIndex === models.length - 1) throw new ModelGatewayError(lastError, attempts, "provider");
        break;
      } finally {
        clearTimeout(timer);
        clearTimeout(firstTokenTimer);
      }
    }
  }
  throw new ModelGatewayError(lastError, attempts, "provider");
}

async function readChatResponse(response: Response, model: string, onDelta?: (update: ModelStreamUpdate) => void): Promise<NormalizedModelResponse> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    const data = await response.json() as { choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }>; usage?: unknown };
    const message = data.choices?.[0]?.message;
    const finishReason = typeof data.choices?.[0]?.finish_reason === "string" ? data.choices[0].finish_reason : null;
    const content = typeof message?.content === "string" ? message.content : "";
    if (content) onDelta?.({ model, delta: content, totalChars: content.length });
    return { content, reasoningContent: typeof message?.reasoning_content === "string" ? message.reasoning_content : "", usage: data.usage, completed: finishReason !== "length", finishReason, streamError: null };
  }

  if (!response.body) throw new Error(`Model ${model} returned an empty stream`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  let usage: unknown;
  let sawDone = false;
  let finishReason: string | null = null;
  let streamError: unknown | null = null;

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      sawDone = true;
      return;
    }
    const chunk = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }>;
      usage?: unknown;
    };
    if (chunk.usage !== undefined) usage = chunk.usage;
    if (typeof chunk.choices?.[0]?.finish_reason === "string") finishReason = chunk.choices[0].finish_reason;
    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.reasoning_content === "string") reasoningContent += delta.reasoning_content;
    if (typeof delta?.content !== "string" || delta.content.length === 0) return;
    content += delta.content;
    onDelta?.({ model, delta: delta.content, totalChars: content.length });
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
      if (done) break;
    }
  } catch (error) {
    streamError = error;
  }
  if (buffer.trim()) {
    try {
      consumeLine(buffer);
    } catch (error) {
      streamError ??= error;
    }
  }
  return { content, reasoningContent, usage, completed: finishReason === "stop" || (sawDone && finishReason !== "length"), finishReason, streamError };
}

async function readResponsesResponse(response: Response, model: string, onDelta?: (update: ModelStreamUpdate) => void): Promise<NormalizedModelResponse> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    const data = await response.json() as ResponsesApiResponse;
    const content = extractResponseText(data);
    if (content) onDelta?.({ model, delta: content, totalChars: content.length });
    const finishReason = responseFinishReason(data);
    return {
      content,
      reasoningContent: "",
      usage: data.usage,
      completed: data.status === "completed",
      finishReason,
      streamError: data.error ? new Error(data.error.message ?? data.error.code ?? "Responses API request failed") : null,
    };
  }

  if (!response.body) throw new Error(`Model ${model} returned an empty stream`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  let usage: unknown;
  let completed = false;
  let finishReason: string | null = null;
  let streamError: unknown | null = null;

  const appendContent = (delta: string) => {
    if (!delta) return;
    content += delta;
    onDelta?.({ model, delta, totalChars: content.length });
  };
  const adoptFinalContent = (text: string) => {
    if (!text || text === content) return;
    if (text.startsWith(content)) appendContent(text.slice(content.length));
    else if (!content) appendContent(text);
  };
  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    const event = JSON.parse(payload) as ResponsesApiStreamEvent;
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      appendContent(event.delta);
      return;
    }
    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      adoptFinalContent(event.text);
      return;
    }
    if (event.type === "response.reasoning_text.delta" && typeof event.delta === "string") {
      reasoningContent += event.delta;
      return;
    }
    if (event.type === "response.completed" && event.response) {
      completed = event.response.status === "completed";
      usage = event.response.usage;
      finishReason = responseFinishReason(event.response) ?? (completed ? "stop" : null);
      adoptFinalContent(extractResponseText(event.response));
      return;
    }
    if (event.type === "response.incomplete" && event.response) {
      usage = event.response.usage;
      finishReason = responseFinishReason(event.response) ?? "incomplete";
      adoptFinalContent(extractResponseText(event.response));
      return;
    }
    if (event.type === "response.failed" && event.response) {
      usage = event.response.usage;
      finishReason = responseFinishReason(event.response) ?? "failed";
      const detail = event.response.error?.message ?? event.response.error?.code ?? "Responses API request failed";
      streamError = new Error(detail);
      return;
    }
    if (event.type === "error") {
      const detail = event.message ?? event.error?.message ?? "Responses API stream failed";
      streamError = new Error(detail);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
      if (done) break;
    }
  } catch (error) {
    streamError ??= error;
  }
  if (buffer.trim()) {
    try {
      consumeLine(buffer);
    } catch (error) {
      streamError ??= error;
    }
  }
  return { content, reasoningContent, usage, completed, finishReason, streamError };
}

type ResponsesApiResponse = {
  status?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: unknown;
  incomplete_details?: { reason?: string | null } | null;
  error?: { code?: string; message?: string } | null;
};

type ResponsesApiStreamEvent = {
  type?: string;
  delta?: string;
  text?: string;
  message?: string;
  error?: { message?: string } | null;
  response?: ResponsesApiResponse;
};

function extractResponseText(response: ResponsesApiResponse): string {
  return (response.output ?? [])
    .flatMap((item) => item.type === "message" || item.type === undefined ? item.content ?? [] : [])
    .filter((part) => part.type === "output_text" || part.type === undefined)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
}

function responseFinishReason(response: ResponsesApiResponse): string | null {
  const reason = response.incomplete_details?.reason;
  if (typeof reason !== "string" || !reason) return response.status === "failed" ? "failed" : null;
  return /max(?:imum)?[_ -]?(?:output[_ -]?)?tokens?/i.test(reason) ? "length" : reason;
}

function protocolForModel(model: string): ModelProtocol {
  // OpenCode Go exposes GPT models through the OpenAI Responses-compatible
  // endpoint, while GLM models use Chat Completions.
  return /^gpt-/i.test(model.trim()) ? "responses" : "chat-completions";
}

function safelyAcceptIncomplete(accept: ((content: string) => boolean) | undefined, content: string): boolean {
  if (!accept) return false;
  try {
    return accept(content);
  } catch {
    return false;
  }
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

function attempt(model: string, status: ModelAttemptStatus, startedAt: number, firstTokenMs: number | null, outputChars: number, statusCode: number | null, usage: ModelUsage, error: string | null): ModelAttempt {
  return { model, status, durationMs: Date.now() - startedAt, firstTokenMs, outputChars, statusCode, usage, error };
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.floor(value) : min));
}
