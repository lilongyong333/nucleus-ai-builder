import cases from "../evals/app-manifest-cases.json";
import { describe, expect, it } from "vitest";
import { buildAppManifest, defaultRuntimeBlueprint, normalizeRuntimeBlueprint } from "./app-manifest";
import type { AgentPlan } from "./types";

describe("fixed app manifest eval set", () => {
  it.each(cases)("maps $id to an isolated and valid runtime contract", (testCase: (typeof cases)[number]) => {
    const plan: AgentPlan = {
      appName: testCase.id,
      summary: testCase.prompt,
      archetype: "interactive-web-app",
      features: [testCase.prompt],
      design: "responsive",
      acceptanceCriteria: ["核心流程可操作", "数据刷新后仍存在"],
    };
    const blueprint = defaultRuntimeBlueprint(testCase.prompt, plan);
    expect(blueprint.collections[0]?.name).toBe(testCase.collection);
    expect(blueprint.collections[0]?.access).toBe(testCase.access);
    expect(blueprint.authMode).toBe(testCase.auth);
    const manifest = buildAppManifest({ projectId: `project-${testCase.id}`, versionId: "version-1", plan, blueprint });
    expect(manifest.database.isolation).toBe("project-namespace");
    expect(manifest.backend.basePath).toBe(`/api/app-runtime/project-${testCase.id}`);
    expect(manifest.capabilities.dataApi).toBe("ready");
    expect(manifest.database.collections[0]?.fields.every((field) => /^[a-z][a-zA-Z0-9_]*$/.test(field.name))).toBe(true);
  });

  it("rejects malformed model schema details and falls back safely", () => {
    const plan: AgentPlan = { appName: "safe", summary: "safe", features: ["保存数据"], design: "clean" };
    const blueprint = normalizeRuntimeBlueprint({
      authMode: "root",
      collections: [{ name: "records; DROP TABLE projects", fields: [{ name: "x", type: "shell", required: true }] }],
      dependencies: { npm: ["react", "react", ""], pip: ["pandas"] },
    }, "保存数据", plan);
    expect(blueprint.authMode).toBe("anonymous");
    expect(blueprint.collections[0]?.name).toBe("items");
    expect(blueprint.dependencies.npm).toEqual(["react"]);
    expect(blueprint.dependencies.pip).toEqual(["pandas"]);
  });
});
