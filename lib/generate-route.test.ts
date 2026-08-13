import { beforeEach, describe, expect, it, vi } from "vitest";
import { starterFiles } from "./runtime";
import type { Project } from "./types";

const mocks = vi.hoisted(() => ({
  buildApp: vi.fn(),
  createPlan: vi.fn(),
  markError: vi.fn(async () => undefined),
  recordGenerationEvent: vi.fn(async (runId: string, projectId: string, input: Record<string, unknown>) => ({
    id: `event-${String(input.sequence)}`,
    runId,
    projectId,
    sequence: Number(input.sequence),
    agent: String(input.agent),
    phase: String(input.phase),
    state: String(input.state),
    title: String(input.title),
    detail: String(input.detail),
    durationMs: null,
    model: null,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: "2026-08-09T00:00:00.000Z",
  })),
}));

const project: Project = {
  id: "project-1",
  title: "Audit test",
  prompt: "Build an audit test",
  status: "draft",
  plan: null,
  intake: null,
  manifest: null,
  files: starterFiles,
  currentVersionId: null,
  publishedVersionId: null,
  slug: null,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  versions: [],
  runs: [],
  messages: [],
};

vi.mock("@/lib/db", () => ({
  beginGeneration: vi.fn(async () => "run-1"),
  consumeGenerationQuota: vi.fn(async () => true),
  getProject: vi.fn(async () => project),
  markError: mocks.markError,
  recordGenerationEvent: mocks.recordGenerationEvent,
  releaseGeneration: vi.fn(),
  saveGeneration: vi.fn(),
}));

vi.mock("@/lib/opencode", () => ({
  activeModel: () => "audit-model",
  createGenerationBudget: () => ({
    maxCalls: 8,
    maxTotalTokens: 50_000,
    deadlineAt: Date.now() + 240_000,
    calls: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    modelsUsed: [],
  }),
  createPlan: mocks.createPlan,
  buildApp: mocks.buildApp,
}));

vi.mock("@/lib/session", () => ({
  resolveVisitorSession: () => ({ id: "a".repeat(32), cookie: null }),
  withVisitorSession: (response: Response) => response,
}));

import { POST } from "@/app/api/generate/route";

describe("generation route streaming and audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createPlan.mockRejectedValue(new Error("intentional model failure"));
  });

  it("streams and persists a terminal failure event with run metrics", async () => {
    const response = await POST(new Request("https://example.com/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, prompt: "Build a failure audit" }),
    }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(mocks.recordGenerationEvent).toHaveBeenCalledTimes(2);
    expect(mocks.markError).toHaveBeenCalledTimes(1);
    expect(body).toContain('"type":"error"');
    expect(body).toContain("intentional model failure");
    expect(mocks.recordGenerationEvent.mock.calls[1]?.[2]).toMatchObject({
      agent: "Ray",
      phase: "failure",
      state: "error",
    });
    expect(mocks.markError).toHaveBeenCalledWith(
      project.id,
      "a".repeat(32),
      "run-1",
      "intentional model failure",
      expect.objectContaining({ modelCalls: 0, repairCount: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
    );
  });

  it("exposes the first agent event before the model build finishes", async () => {
    let rejectBuild: ((reason: Error) => void) | undefined;
    const pendingBuild = new Promise((_resolve, reject) => { rejectBuild = reject; });
    mocks.createPlan.mockResolvedValue({
      plan: { appName: "流式测试", summary: "验证首片", features: ["首片可见"], design: "测试界面" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      durationMs: 1,
      modelCalls: 0,
      model: "Iris deterministic SOP",
      usedFallback: false,
    });
    mocks.buildApp.mockReturnValue(pendingBuild);

    const response = await POST(new Request("https://example.com/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, prompt: "Build a responsive stream" }),
    }));
    const reader = response.body!.getReader();
    const firstRead = reader.read();
    const first = await Promise.race([
      firstRead,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("first stream event was buffered")), 250)),
    ]);
    expect(new TextDecoder().decode(first.value)).toContain('"type":"status"');
    expect(new TextDecoder().decode(first.value)).toContain("理解需求");

    rejectBuild?.(new Error("finish stream test"));
    while (!(await reader.read()).done) { /* drain so the route can close cleanly */ }
  });
});
