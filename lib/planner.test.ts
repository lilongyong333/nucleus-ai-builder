import { describe, expect, it } from "vitest";
import { planFromPrompt } from "./planner";

describe("deterministic Iris planner", () => {
  it("turns a detailed request into a bounded reviewable plan", () => {
    const plan = planFromPrompt("做一个深色财务仪表盘；支持新增和删除记录；可以按类型筛选；统计实时更新；适配手机");
    expect(plan.appName).toBe("深色财务仪表盘");
    expect(plan.features.length).toBeGreaterThanOrEqual(3);
    expect(plan.features.length).toBeLessThanOrEqual(5);
    expect(plan.features.join(" ")).toContain("筛选");
    expect(plan.design).toContain("深色");
  });

  it("marks an existing project as an iteration", () => {
    expect(planFromPrompt("增加深色模式", true).summary).toMatch(/^继续迭代/);
  });
});
