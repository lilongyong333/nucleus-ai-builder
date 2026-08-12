import { describe, expect, it, vi } from "vitest";
import { createModelBudget, ModelGatewayError, requestChat } from "./model-gateway";

const messages = [{ role: "user" as const, content: "hello" }];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sse = (...chunks: string[]) => new Response(new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
    controller.close();
  },
}), { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
const budget = (overrides: Partial<Parameters<typeof createModelBudget>[0]> = {}) => createModelBudget({ maxCalls: 6, maxTotalTokens: 10_000, maxDurationMs: 30_000, ...overrides });

describe("model gateway", () => {
  it("tracks a successful provider response", async () => {
    const fetcher = vi.fn(async () => json({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    const shared = budget();
    const result = await requestChat({ baseUrl: "https://provider.test/v1", apiKey: "test", models: ["primary"], messages, maxTokens: 20, requestTimeoutMs: 1000, budget: shared, fetcher });
    expect(result).toMatchObject({ content: "OK", model: "primary", calls: 1, usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } });
    expect(shared).toMatchObject({ calls: 1, usage: { totalTokens: 7 }, modelsUsed: ["primary"] });
  });

  it("consumes OpenAI-compatible SSE chunks and reports visible content deltas", async () => {
    const updates: Array<{ delta: string; totalChars: number }> = [];
    let requestInit: RequestInit | undefined;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://provider.test/v1/chat/completions");
      requestInit = init;
      return sse(
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"hidden reasoning"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      );
    });
    const result = await requestChat({
      baseUrl: "https://provider.test/v1",
      apiKey: "test",
      models: ["primary"],
      messages,
      maxTokens: 20,
      requestTimeoutMs: 1000,
      budget: budget(),
      fetcher,
      onDelta: ({ delta, totalChars }) => updates.push({ delta, totalChars }),
    });

    expect(result).toMatchObject({ content: "Hello world", usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } });
    expect(updates).toEqual([{ delta: "Hello ", totalChars: 6 }, { delta: "world", totalChars: 11 }]);
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it("routes GPT models through the Responses API and consumes its stream events", async () => {
    const updates: Array<{ delta: string; totalChars: number }> = [];
    let requestInit: RequestInit | undefined;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://provider.test/v1/responses");
      requestInit = init;
      return sse(
        'data: {"type":"response.output_text.delta","delta":"Hello "}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Responses"}\n\n',
        'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}\n\n',
      );
    });
    const result = await requestChat({
      baseUrl: "https://provider.test/v1",
      apiKey: "test",
      models: ["gpt-5.6-luna"],
      messages,
      maxTokens: 1234,
      requestTimeoutMs: 1000,
      budget: budget(),
      fetcher,
      onDelta: ({ delta, totalChars }) => updates.push({ delta, totalChars }),
    });

    expect(result).toMatchObject({ content: "Hello Responses", model: "gpt-5.6-luna", usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } });
    expect(updates).toEqual([{ delta: "Hello ", totalChars: 6 }, { delta: "Responses", totalChars: 15 }]);
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      model: "gpt-5.6-luna",
      input: messages,
      max_output_tokens: 1234,
      stream: true,
    });
  });

  it("treats a Responses API max-token event as truncation", async () => {
    const fetcher = vi.fn(async () => sse(
      'data: {"type":"response.output_text.delta","delta":"{\\"summary\\":\\"looks complete\\"}"}\n\n',
      'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":4,"output_tokens":20,"total_tokens":24}}}\n\n',
    ));
    const error = await requestChat({
      baseUrl: "https://provider.test/v1",
      apiKey: "test",
      models: ["gpt-5.6-luna"],
      messages,
      maxTokens: 20,
      requestTimeoutMs: 1000,
      budget: budget(),
      fetcher,
      acceptIncomplete: () => true,
    }).catch((cause) => cause);
    expect(error).toBeInstanceOf(ModelGatewayError);
    expect(error.attempts[0]).toMatchObject({ status: "incomplete", usage: { totalTokens: 24 }, error: "Incomplete model stream (finish_reason=length)" });
  });

  it("does not recover content from an explicit Responses API failure", async () => {
    const fetcher = vi.fn(async () => sse(
      'data: {"type":"response.output_text.delta","delta":"{\\"summary\\":\\"must not pass\\"}"}\n\n',
      'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"generation failed"}}}\n\n',
    ));
    const error = await requestChat({
      baseUrl: "https://provider.test/v1",
      apiKey: "test",
      models: ["gpt-5.6-luna"],
      messages,
      maxTokens: 200,
      requestTimeoutMs: 1000,
      budget: budget(),
      fetcher,
      acceptIncomplete: () => true,
    }).catch((cause) => cause);
    expect(error).toBeInstanceOf(ModelGatewayError);
    expect(error.attempts[0]).toMatchObject({ status: "network_error", error: "Incomplete model stream (finish_reason=failed): generation failed" });
  });

  it("fails over when a stream closes without a terminal event", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model;
      return model === "primary"
        ? sse('data: {"choices":[{"delta":{"content":"partial function() {"}}]}\n\n')
        : sse(
          'data: {"choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        );
    });
    const result = await requestChat({ baseUrl: "https://provider.test/v1", apiKey: "test", models: ["primary", "fallback"], messages, maxTokens: 20, requestTimeoutMs: 1000, budget: budget(), fetcher });
    expect(result.content).toBe("complete");
    expect(result.attempts.map((item) => item.status)).toEqual(["incomplete", "success"]);
  });

  it("recovers a structurally complete artifact when the provider omits the terminal event", async () => {
    const fetcher = vi.fn(async () => sse('data: {"choices":[{"delta":{"content":"{\\"summary\\":\\"complete\\"}"}}]}\n\n'));
    const result = await requestChat({
      baseUrl: "https://provider.test/v1",
      apiKey: "test",
      models: ["primary", "fallback"],
      messages,
      maxTokens: 200,
      requestTimeoutMs: 1000,
      budget: budget(),
      fetcher,
      acceptIncomplete: (content) => JSON.parse(content).summary === "complete",
    });
    expect(result).toMatchObject({ content: '{"summary":"complete"}', model: "primary", calls: 1 });
    expect(result.attempts).toMatchObject([{ status: "recovered", error: expect.stringContaining("omitted its terminal event") }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects finish_reason length as a truncated completion", async () => {
    const fetcher = vi.fn(async () => sse(
      'data: {"choices":[{"delta":{"content":"truncated"},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n',
    ));
    const error = await requestChat({ baseUrl: "https://provider.test/v1", apiKey: "test", models: ["primary"], messages, maxTokens: 20, requestTimeoutMs: 1000, budget: budget(), fetcher }).catch((cause) => cause);
    expect(error).toBeInstanceOf(ModelGatewayError);
    expect(error.attempts[0]).toMatchObject({ status: "incomplete", error: "Incomplete model stream (finish_reason=length)" });
  });

  it("fails over when the primary model is unavailable", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model;
      return model === "primary" ? new Response("model unavailable", { status: 503 }) : json({ choices: [{ message: { content: "fallback result" } }], usage: { total_tokens: 9 } });
    });
    const result = await requestChat({ baseUrl: "https://provider.test/v1", apiKey: "test", models: ["primary", "fallback"], messages, maxTokens: 20, requestTimeoutMs: 1000, budget: budget(), fetcher });
    expect(result.model).toBe("fallback");
    expect(result.attempts.map((item) => item.status)).toEqual(["http_error", "success"]);
  });

  it("fails over after a bounded primary timeout", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model;
      if (model === "fallback") return json({ choices: [{ message: { content: "recovered" } }], usage: { total_tokens: 5 } });
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal instanceof AbortSignal ? init.signal.reason : new Error("aborted")), { once: true });
      });
    });
    const result = await requestChat({ baseUrl: "https://provider.test/v1", apiKey: "test", models: ["primary", "fallback"], messages, maxTokens: 20, requestTimeoutMs: 5, budget: budget(), fetcher });
    expect(result.model).toBe("fallback");
    expect(result.attempts.map((item) => item.status)).toEqual(["timeout", "success"]);
  });

  it("does not hide authentication failures behind a fallback", async () => {
    const fetcher = vi.fn(async () => new Response("invalid key", { status: 401 }));
    await expect(requestChat({ baseUrl: "https://provider.test/v1", apiKey: "test", models: ["primary", "fallback"], messages, maxTokens: 20, requestTimeoutMs: 1000, budget: budget(), fetcher })).rejects.toMatchObject({ kind: "provider" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("audits caller cancellation without contacting another model", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal instanceof AbortSignal ? init.signal.reason : new Error("aborted")), { once: true });
      controller.abort(new DOMException("cancelled", "AbortError"));
    }));
    const error = await requestChat({ baseUrl: "https://provider.test/v1", apiKey: "test", models: ["primary", "fallback"], messages, maxTokens: 20, requestTimeoutMs: 1000, budget: budget(), signal: controller.signal, fetcher }).catch((cause) => cause);
    expect(error).toBeInstanceOf(ModelGatewayError);
    expect(error).toMatchObject({ kind: "provider", attempts: [{ status: "cancelled" }] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reserves time by switching to the fallback after one empty completion", async () => {
    let calls = 0;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      calls += 1;
      const model = JSON.parse(String(init.body)).model;
      if (model === "primary") return json({ choices: [{ message: { content: "" } }], usage: { total_tokens: 3 } });
      return json({ choices: [{ message: { content: "usable" } }], usage: { total_tokens: 4 } });
    });
    const result = await requestChat({ baseUrl: "https://provider.test/v1", apiKey: "test", models: ["primary", "fallback"], messages, maxTokens: 20, requestTimeoutMs: 1000, budget: budget(), fetcher });
    expect(calls).toBe(2);
    expect(result.attempts.map((item) => item.status)).toEqual(["empty", "success"]);
    expect(result.usage.totalTokens).toBe(7);
  });

  it("enforces the shared call budget before another provider request", async () => {
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await expect(requestChat({ baseUrl: "https://provider.test/v1", apiKey: "test", models: ["primary", "fallback"], messages, maxTokens: 20, requestTimeoutMs: 1000, budget: budget({ maxCalls: 1 }), fetcher })).rejects.toMatchObject({ kind: "budget" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops when provider-reported usage exceeds the token budget", async () => {
    const fetcher = vi.fn(async () => json({ choices: [{ message: { content: "too expensive" } }], usage: { total_tokens: 1500 } }));
    const error = await requestChat({ baseUrl: "https://provider.test/v1", apiKey: "test", models: ["primary"], messages, maxTokens: 20, requestTimeoutMs: 1000, budget: budget({ maxTotalTokens: 1000 }), fetcher }).catch((cause) => cause);
    expect(error).toBeInstanceOf(ModelGatewayError);
    expect(error).toMatchObject({ kind: "budget" });
    expect(error.attempts[0].status).toBe("budget_exceeded");
  });
});
