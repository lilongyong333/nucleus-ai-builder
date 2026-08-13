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
    intake: null,
    manifest: null,
    files: starterFiles,
    currentVersionId: versionId,
    publishedVersionId: versionNumber > 1 ? "version-1" : null,
    slug: versionNumber > 1 ? "interview-board" : null,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:01:00.000Z",
    versions: [{ id: versionId, projectId: "e2e-project", versionNumber, files: starterFiles, summary: `版本 ${versionNumber}`, model: "test-model", quality, manifest: null, createdAt: "2026-08-09T00:01:00.000Z" }],
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
      mode: "standard",
      currentStage: "completed",
      artifacts: [],
      attempts: [],
      candidates: [],
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

function runningProject(base: Project, runId: string, prompt: string): Project {
  return {
    ...base,
    status: "generating",
    runs: [{ ...base.runs[0], id: runId, prompt, status: "running", completedAt: null, durationMs: null, versionId: null, currentStage: "requirements", events: [], artifacts: [], attempts: [] }, ...base.runs],
    messages: [...base.messages, { id: `message-${runId}`, projectId: base.id, role: "user", content: prompt, createdAt: "2026-08-09T00:02:00.000Z" }],
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
  await expect(page.locator(".live-demo-grid > a")).toHaveCount(4);
  await expect(page.getByRole("link", { name: /BudgetLens 财务 CRUD/ })).toHaveAttribute("href", "/p/budgetlens-4e9b1d");
  const promptInput = page.getByLabel("描述你想创建的应用");
  await promptInput.fill("制作一个面试计划板");
  await expect(promptInput).toHaveValue("制作一个面试计划板");
  await expect(page.getByRole("button", { name: "开始构建" })).toBeEnabled();
  await page.getByRole("button", { name: "开始构建" }).click();

  await expect(page).toHaveURL(/\/w\/e2e-project$/);
  await expect(page.getByTitle("面试计划板 预览")).toBeVisible();
  await expect(page.locator(".runtime-status.passed")).toContainText("已保存版本启动通过");
  await expect(page.locator(".conversation-feed")).toContainText("制作一个面试计划板");
  await expect(page.locator(".conversation-quality > strong")).toContainText("92");
  await expect(page.locator(".run-audit-card")).toContainText("200");
  await page.getByRole("button", { name: "切换控制台" }).click();
  await expect(page.locator(".runtime-console")).toContainText("应用启动完成");
  await page.getByRole("button", { name: "关闭控制台" }).click();
  await page.getByRole("button", { name: /对话/ }).click();
  await expect(page.getByText("项目对话记忆")).toBeVisible();
  await expect(page.locator(".memory-drawer").getByText("制作一个面试计划板")).toBeVisible();
  await page.getByRole("button", { name: "关闭对话记忆" }).click();
  await page.getByRole("link", { name: "返回首页" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: /描述一个想法/ })).toBeVisible();
});

test("renders streamed agent review and the completed version", async ({ page }) => {
  const initialProject = project();
  const completedProject = project(2, finalQuality);
  const activeProject = runningProject(initialProject, "run-update", "增加任务优先级");
  await page.route("**/api/projects/e2e-project", (route) => route.fulfill({ json: { project: initialProject } }));
  await page.route("**/api/runs", (route) => route.fulfill({ status: 201, json: { runId: "run-update", project: activeProject } }));
  await page.route("**/api/runs/run-update/step", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: [
        JSON.stringify({ type: "status", agent: "Iris", title: "需求分析完成", detail: "2 个可验证功能", state: "done" }),
        JSON.stringify({ type: "review", report: finalQuality }),
        JSON.stringify({ type: "complete", project: completedProject }),
      ].join("\n") + "\n",
    });
  });

  await page.goto("/w/e2e-project");
  await page.getByPlaceholder("告诉团队你想修改什么…").fill("增加任务优先级");
  await page.getByRole("button", { name: "发送修改需求" }).click();

  await expect(page.locator(".live-build-monitor")).toBeVisible();
  await expect(page.locator(".generation-stream-card")).toHaveCount(0);

  await expect(page.locator(".conversation-quality > strong")).toContainText("100");
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
  const accountProject = project(2, finalQuality);
  await page.route("**/api/projects", (route) => route.fulfill({ json: { projects: [accountProject], account: { email: "candidate@example.com", displayName: "候选人" } } }));
  await page.route("**/api/projects/e2e-project", (route) => route.fulfill({ json: { project: accountProject } }));

  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "候选人" })).toBeVisible();
  await expect(page.getByText("candidate@example.com", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "我的项目与成品链接" })).toBeVisible();
  await expect(page.getByText("工作台详细链接")).toBeVisible();
  await expect(page.getByText("公开成品链接")).toBeVisible();
  await expect(page.getByRole("link", { name: /打开工作台/ })).toHaveAttribute("href", "/w/e2e-project");
  await page.getByRole("link", { name: /打开工作台/ }).click();
  await expect(page).toHaveURL(/\/w\/e2e-project$/);
  await expect(page.locator(".project-title strong")).toHaveText("面试计划板");
  await page.getByRole("link", { name: "返回首页" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("link", { name: "候选人" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await page.getByRole("link", { name: "新建应用" }).click();
  await expect(page).toHaveURL(/\/$/);
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
  let stepPosts = 0;
  await page.route("**/api/projects/e2e-project", (route) => {
    reads += 1;
    return route.fulfill({ json: { project: reads === 1 ? inFlightProject : completedProject } });
  });
  await page.route("**/api/runs/run-1/step", (route) => {
    stepPosts += 1;
    return route.fulfill({ status: 200, contentType: "application/x-ndjson; charset=utf-8", body: `${JSON.stringify({ type: "complete", project: completedProject })}\n` });
  });

  await page.goto("/w/e2e-project");
  await expect(page.locator(".project-title small")).toHaveText("已保存", { timeout: 8000 });
  await expect(page.locator(".agent-step-card")).toContainText("结果已恢复");
  await expect(page.getByRole("button", { name: /版本 v1/ })).toBeVisible();
  expect(stepPosts).toBe(1);
});

test("shows a clear access error instead of an endless loading state", async ({ page }) => {
  await page.route("**/api/projects/missing-project", (route) => route.fulfill({ status: 404, json: { error: "项目不存在" } }));
  await page.goto("/w/missing-project");
  await expect(page.getByRole("heading", { name: "无法打开这个项目" })).toBeVisible();
  await expect(page.getByText("项目不存在", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回首页创建新应用" })).toHaveAttribute("href", "/");
  await expect(page.getByText("正在打开工作台…")).toHaveCount(0);
});

test("queues a second message with Return while the current generation is running", async ({ page }) => {
  const initialProject = project();
  const firstCompleted = project(2, finalQuality);
  const secondCompleted = project(3, finalQuality);
  let generationPosts = 0;
  await page.route("**/api/projects/e2e-project", (route) => route.fulfill({ json: { project: initialProject } }));
  await page.route("**/api/runs", async (route) => {
    generationPosts += 1;
    const currentCall = generationPosts;
    const requestBody = route.request().postDataJSON() as { prompt: string };
    const active = runningProject(initialProject, `queue-run-${currentCall}`, requestBody.prompt);
    await route.fulfill({ status: 201, json: { runId: `queue-run-${currentCall}`, project: active } });
  });
  await page.route("**/api/runs/queue-run-*/step", async (route) => {
    const currentCall = route.request().url().includes("queue-run-1") ? 1 : 2;
    await new Promise((resolve) => setTimeout(resolve, currentCall === 1 ? 700 : 120));
    const completed = currentCall === 1 ? firstCompleted : secondCompleted;
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: [
        JSON.stringify({ type: "status", agent: "Iris", title: "理解需求", detail: "正在处理队列消息", state: "working" }),
        JSON.stringify({ type: "complete", project: completed }),
      ].join("\n") + "\n",
    });
  });

  await page.goto("/w/e2e-project");
  const composer = page.getByRole("textbox", { name: "修改需求" });
  await composer.fill("第一条：增加搜索功能");
  await composer.press("Enter");
  await expect(page.locator(".project-title small")).toHaveText("生成中");
  await composer.fill("第二条：增加深色模式");
  await composer.press("Enter");
  await expect(page.locator(".message-queue")).toContainText("第二条：增加深色模式");
  await expect.poll(() => generationPosts, { timeout: 5000 }).toBe(2);
  await expect(page.getByRole("button", { name: /版本 v3/ })).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".message-queue")).toHaveCount(0);
});

test("asks Iris for three directions and starts the real build with one selection", async ({ page }) => {
  const ready = project();
  const draft: Project = { ...ready, status: "draft", plan: null, currentVersionId: null, publishedVersionId: null, slug: null, versions: [], runs: [], messages: ready.messages.slice(0, 1) };
  const intake = {
    summary: "我已经把面试计划板整理成可执行方向。",
    assumptions: ["所有核心按钮真实可用", "覆盖桌面与移动端"],
    question: "你更希望第一版采用哪种产品方向？",
    options: [
      { id: "minimal", label: "极简实用", description: "聚焦任务流程", promptSuffix: "采用极简实用风格并实现完整 CRUD。", recommended: true },
      { id: "dense", label: "专业信息密集", description: "成熟工作台", promptSuffix: "采用专业工作台风格。", recommended: false },
      { id: "bold", label: "大胆表现力", description: "强化视觉反馈", promptSuffix: "采用大胆视觉并保留可访问性。", recommended: false },
    ],
    source: "model" as const,
  };
  const clarified: Project = { ...draft, intake, messages: [...draft.messages, { id: "iris-intake", projectId: draft.id, role: "assistant", content: `${intake.summary}\n\n${intake.question}`, createdAt: "2026-08-09T00:00:01.000Z" }] };
  const running = runningProject(ready, "intake-run", "采用极简实用风格并实现完整 CRUD");
  let runPosts = 0;
  await page.route("**/api/projects/e2e-project", (route) => route.fulfill({ json: { project: draft } }));
  await page.route("**/api/projects/e2e-project/intake", (route) => route.fulfill({ json: { intake, project: clarified, recovered: false } }));
  await page.route("**/api/runs", (route) => { runPosts += 1; return route.fulfill({ status: 201, json: { runId: "intake-run", project: running } }); });
  await page.route("**/api/runs/intake-run/step", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson; charset=utf-8", body: `${JSON.stringify({ type: "complete", project: ready })}\n` }));
  await page.goto("/w/e2e-project");
  await expect(page.getByText("VERSION 0 · NO GENERATED APP")).toBeVisible();
  await expect(page.getByLabel("Iris 产品方向选择")).toBeVisible();
  await expect(page.locator(".intake-options > button")).toHaveCount(3);
  await expect(page.getByTitle("面试计划板 预览")).toHaveCount(0);
  expect(runPosts).toBe(0);
  await page.getByRole("button", { name: /极简实用/ }).click();
  await expect.poll(() => runPosts).toBe(1);
  await expect(page.getByRole("button", { name: /版本 v1/ })).toBeVisible();
});

test("selects and previews a DOM element from a touch-sized mobile viewport", async ({ browser }) => {
  const initialProject = project();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.route("**/api/projects/e2e-project", (route) => route.fulfill({ json: { project: initialProject } }));
  await page.goto("/w/e2e-project");
  await page.getByRole("button", { name: "收起侧栏" }).click();
  await expect(page.locator(".runtime-status.passed")).toBeVisible();
  await page.getByRole("button", { name: "手机预览" }).click();
  await page.getByRole("button", { name: "选择页面元素进行局部修改" }).click();
  const generatedButton = page.frameLocator("iframe").getByRole("button", { name: "添加任务" });
  await generatedButton.evaluate((element) => {
    element.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  const panel = page.locator(".visual-edit-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator("code")).toContainText("button");
  await panel.getByLabel("高度").fill("52px");
  await panel.getByLabel("Display").fill("grid");
  await panel.getByRole("button", { name: "预览修改" }).click();
  await expect(page.getByText("局部样式已在预览中应用", { exact: false })).toBeVisible();
  await context.close();
});

test("creates and reopens a real local D1-backed draft without API mocks", async ({ page }) => {
  await page.goto("/");
  const created = await page.evaluate(async () => {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: `E2E 实际控制面草稿 ${Date.now()}` }),
    });
    return { status: response.status, body: await response.json() as { project?: { id?: string }; error?: string } };
  });
  expect(created.status, created.body.error).toBe(201);
  const projectId = created.body.project?.id;
  expect(projectId).toMatch(/^[a-f0-9-]{36}$/i);
  await page.goto(`/w/${projectId}`);
  await expect(page.getByText("VERSION 0 · NO GENERATED APP")).toBeVisible();
  await page.reload();
  await expect(page.getByText("VERSION 0 · NO GENERATED APP")).toBeVisible();
});
