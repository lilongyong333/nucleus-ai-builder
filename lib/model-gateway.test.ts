import { describe, expect, it, vi } from "vitest";
import { createModelBudget, ModelGatewayError, requestChat } from "./model-gateway";

const messages = [{ role: "user" as const, content: "hello" }];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const budget = (overrides: Partial<Parameters<typeof createModelBudget>[0]> = {}) => createModelBudget({ maxCalls: 6, maxTotalTokens: 10_000, maxDurationMs: 30_000, ...overrides });

describe("model gateway", () => {
  it("tracks a successful provider response", async () => {
    const fetcher = vi.fn(async () => json({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    const shared = budget();
    const result = await requestChat({ baseUrl: "https://provider.test/v1", apiKey: "test", models: ["primary"], messages, maxTokens: 20, requestTimeoutMs: 1000, budget: shared, fetcher });
    expect(result).toMatchObject({ content: "OK", model: "primary", calls: 1, usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } });
    expect(shared).toMatchObject({ calls: 1, usage: { totalTokens: 7 }, modelsUsed: ["primary"] });
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

  it("propagates caller cancellation without contacting another model", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal instanceof AbortSignal ? init.signal.reason : new Error("aborted")), { once: true });
      controller.abort(new DOMException("cancelled", "AbortError"));
    }));
    const error = await requestChat({ baseUrl: "https://provider.test/v1", apiKey: "test", models: ["primary", "fallback"], messages, maxTokens: 20, requestTimeoutMs: 1000, budget: budget(), signal: controller.signal, fetcher }).catch((cause) => cause);
    expect(error).toBeInstanceOf(DOMException);
    expect(error.name).toBe("AbortError");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries one empty completion before using the fallback", async () => {
    let calls = 0;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      calls += 1;
      const model = JSON.parse(String(init.body)).model;
      if (model === "primary") return json({ choices: [{ message: { content: "" } }], usage: { total_tokens: 3 } });
      return json({ choices: [{ message: { content: "usable" } }], usage: { total_tokens: 4 } });
    });
    const result = await requestChat({ baseUrl: "https://provider.test/v1", apiKey: "test", models: ["primary", "fallback"], messages, maxTokens: 20, requestTimeoutMs: 1000, budget: budget(), fetcher });
    expect(calls).toBe(3);
    expect(result.attempts.map((item) => item.status)).toEqual(["empty", "empty", "success"]);
    expect(result.usage.totalTokens).toBe(10);
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
