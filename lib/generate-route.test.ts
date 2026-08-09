import { beforeEach, describe, expect, it, vi } from "vitest";
import { starterFiles } from "./runtime";
import type { Project } from "./types";

const mocks = vi.hoisted(() => ({
  markError: vi.fn(),
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
  createPlan: vi.fn(async () => { throw new Error("intentional model failure"); }),
  buildApp: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  resolveVisitorSession: () => ({ id: "a".repeat(32), cookie: null }),
  withVisitorSession: (response: Response) => response,
}));

import { POST } from "@/app/api/generate/route";

describe("generation route audit failures", () => {
  beforeEach(() => vi.clearAllMocks());

  it("streams and persists a terminal failure event with run metrics", async () => {
    const response = await POST(new Request("https://example.com/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, prompt: "Build a failure audit" }),
    }));
    const body = await response.text();

    expect(response.status).toBe(200);
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
});
