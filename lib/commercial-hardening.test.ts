import { describe, expect, it } from "vitest";
import { buildAppManifest, defaultRuntimeBlueprint } from "./app-manifest";
import { databaseSchemaRevision, provisioningRetryDelayMs } from "./database-schema";
import { boundedExponentialDelayMs } from "./retry-policy";
import type { AgentPlan } from "./types";

const plan: AgentPlan = { appName: "Provisioner", summary: "保存任务", features: ["保存任务"], design: "responsive" };

describe("commercial control-plane hardening", () => {
  it("changes the physical schema revision only when the database contract changes", async () => {
    const blueprint = defaultRuntimeBlueprint("保存任务", plan);
    const base = buildAppManifest({ projectId: "project-1", versionId: "v1", plan, blueprint });
    const uiOnly = { ...base, versionId: "v2", appName: "只改页面文案" };
    const schemaChange = structuredClone(base);
    schemaChange.database.collections[0].fields.push({ name: "priority", type: "number", required: false, default: 0 });
    expect(await databaseSchemaRevision(uiOnly)).toBe(await databaseSchemaRevision(base));
    expect(await databaseSchemaRevision(schemaChange)).not.toBe(await databaseSchemaRevision(base));
  });

  it("bounds retry backoff to prevent hot loops and unbounded delays", () => {
    expect([1, 2, 3, 20].map(provisioningRetryDelayMs)).toEqual([30_000, 60_000, 120_000, 15_360_000]);
    expect([1, 2, 3, 20].map((attempt) => boundedExponentialDelayMs(attempt, 60_000, 8))).toEqual([60_000, 120_000, 240_000, 7_680_000]);
  });
});
