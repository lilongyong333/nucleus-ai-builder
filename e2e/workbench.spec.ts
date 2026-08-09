import { expect, test } from "@playwright/test";
import { starterFiles } from "../lib/runtime";
import type { AppQualityReport, Project } from "../lib/types";

const firstQuality: AppQualityReport = {
  score: 92,
  grade: "A",
  passed: true,
  checks: [{ id: "syntax", label: "JavaScript 语法", severity: "pass", detail: "通过", weight: 24 }],
  summary: "Ray 完成检查",
};

const finalQuality: AppQualityReport = {
  ...firstQuality,
  score: 100,
  checks: [
    { id: "syntax", label: "JavaScript 语法", severity: "pass", detail: "通过", weight: 24 },
    { id: "interaction", label: "真实交互", severity: "pass", detail: "通过", weight: 18 },
  ],
};

function project(versionNumber = 1, quality = firstQuality): Project {
  const versionId = `version-${versionNumber}`;
  return {
    id: "e2e-project",
    title: "面试计划板",
    prompt: "制作一个面试计划板",
    status: "ready",
    plan: { appName: "面试计划板", summary: "安排准备任务", features: ["新增任务", "完成筛选"], design: "清晰响应式界面" },
    files: starterFiles,
    currentVersionId: versionId,
    publishedVersionId: versionNumber > 1 ? "version-1" : null,
    slug: versionNumber > 1 ? "interview-board" : null,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:01:00.000Z",
    versions: [{ id: versionId, projectId: "e2e-project", versionNumber, files: starterFiles, summary: `版本 ${versionNumber}`, model: "test-model", quality, createdAt: "2026-08-09T00:01:00.000Z" }],
    runs: [{
      id: `run-${versionNumber}`,
      projectId: "e2e-project",
      prompt: "制作一个面试计划板",
      status: "completed",
      model: "test-model",
      startedAt: "2026-08-09T00:00:58.800Z",
      completedAt: "2026-08-09T00:01:00.000Z",
      durationMs: 1200,
      usage: { promptTokens: 120, completionTokens: 80, totalTokens: 200 },
      modelCalls: 1,
      repairCount: 0,
      versionId,
      error: null,
      events: [{
        id: `event-${versionNumber}`,
        runId: `run-${versionNumber}`,
        projectId: "e2e-project",
        sequence: 1,
        agent: "Iris",
        phase: "requirements",
        state: "done",
        title: "需求分析完成",
        detail: "2 个可验证功能",
        durationMs: 300,
        model: "test-model",
        usage: { promptTokens: 60, completionTokens: 40, totalTokens: 100 },
        createdAt: "2026-08-09T00:00:59.100Z",
      }],
    }],
    messages: [
      { id: "message-user", projectId: "e2e-project", role: "user", content: "制作一个面试计划板", createdAt: "2026-08-09T00:00:00.000Z" },
      { id: "message-assistant", projectId: "e2e-project", role: "assistant", content: `版本 ${versionNumber} 已生成`, createdAt: "2026-08-09T00:01:00.000Z" },
    ],
  };
}

test("creates a project and opens the functional workbench", async ({ page }) => {
  const initialProject = project();
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: { projects: [] } });
    else await route.fulfill({ status: 201, json: { project: initialProject } });
  });
  await page.route("**/api/projects/e2e-project", (route) => route.fulfill({ json: { project: initialProject } }));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /描述一个想法/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始构建" })).toBeVisible();
  await expect(page.locator(".live-demo-grid > a")).toHaveCount(3);
  await expect(page.getByRole("link", { name: /BudgetLens 财务 CRUD/ })).toHaveAttribute("href", "/p/budgetlens-4e9b1d");
  const promptInput = page.getByLabel("描述你想创建的应用");
  await promptInput.fill("制作一个面试计划板");
  await expect(promptInput).toHaveValue("制作一个面试计划板");
  await expect(page.getByRole("button", { name: "开始构建" })).toBeEnabled();
  await page.getByRole("button", { name: "开始构建" }).click();

  await expect(page).toHaveURL(/\/w\/e2e-project$/);
  await expect(page.getByTitle("面试计划板 预览")).toBeVisible();
  await expect(page.locator(".runtime-status.passed")).toContainText("启动校验通过");
  await expect(page.locator(".quality-score strong")).toHaveText("92");
  await expect(page.locator(".run-audit-card")).toContainText("200");
  await page.getByRole("button", { name: /对话/ }).click();
  await expect(page.getByText("项目对话记忆")).toBeVisible();
  await expect(page.getByText("制作一个面试计划板")).toBeVisible();
});

test("renders streamed agent review and the completed version", async ({ page }) => {
  const initialProject = project();
  const completedProject = project(2, finalQuality);
  await page.route("**/api/projects/e2e-project", (route) => route.fulfill({ json: { project: initialProject } }));
  await page.route("**/api/generate", (route) => route.fulfill({
    status: 200,
    contentType: "application/x-ndjson; charset=utf-8",
    body: [
      JSON.stringify({ type: "status", agent: "Iris", title: "需求分析完成", detail: "2 个可验证功能", state: "done" }),
      JSON.stringify({ type: "review", report: finalQuality }),
      JSON.stringify({ type: "complete", project: completedProject }),
    ].join("\n") + "\n",
  }));

  await page.goto("/w/e2e-project");
  await page.getByPlaceholder("告诉团队你想修改什么…").fill("增加任务优先级");
  await page.getByRole("button", { name: "发送修改需求" }).click();

  await expect(page.locator(".quality-score strong")).toHaveText("100");
  await page.locator(".run-audit-card summary").click();
  await expect(page.locator(".run-audit-card")).toContainText("Iris");
  await expect(page.getByText("v2 已保存")).toBeVisible();
  await page.locator(".topbar-actions button").filter({ hasText: "版本" }).click();
  await expect(page.getByText("Ray 100/100")).toBeVisible();
});

test("shows a signed-in account project library with detailed links", async ({ page }) => {
  await page.setExtraHTTPHeaders({
    "oai-authenticated-user-id": "e2e-account",
    "oai-authenticated-user-email": "candidate@example.com",
    "oai-authenticated-user-full-name": encodeURIComponent("候选人"),
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  });
  await page.route("**/api/projects", (route) => route.fulfill({ json: { projects: [project(2, finalQuality)] } }));

  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "候选人" })).toBeVisible();
  await expect(page.getByText("candidate@example.com", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "我的项目与成品链接" })).toBeVisible();
  await expect(page.getByText("工作台详细链接")).toBeVisible();
  await expect(page.getByText("公开成品链接")).toBeVisible();
  await expect(page.getByRole("link", { name: /打开工作台/ })).toHaveAttribute("href", "/w/e2e-project");
});

test("recovers a server-side generation after the browser stream disconnects", async ({ page }) => {
  const completedProject = project();
  const inFlightProject: Project = {
    ...completedProject,
    status: "generating",
    currentVersionId: null,
    versions: [],
    runs: [{ ...completedProject.runs[0], status: "running", completedAt: null, durationMs: null, versionId: null }],
    messages: completedProject.messages.slice(0, 1),
  };
  let reads = 0;
  let generationPosts = 0;
  await page.route("**/api/projects/e2e-project", (route) => {
    reads += 1;
    return route.fulfill({ json: { project: reads === 1 ? inFlightProject : completedProject } });
  });
  await page.route("**/api/generate", (route) => {
    generationPosts += 1;
    return route.fulfill({ status: 409, json: { error: "already running" } });
  });

  await page.goto("/w/e2e-project");
  await expect(page.locator(".project-title small")).toHaveText("已保存", { timeout: 8000 });
  await expect(page.getByRole("heading", { name: "结果已恢复" })).toBeVisible();
  await expect(page.getByRole("button", { name: /版本 v1/ })).toBeVisible();
  expect(generationPosts).toBe(0);
});
