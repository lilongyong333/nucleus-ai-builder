import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const jobId = required("NUCLEUS_EVAL_JOB_ID");
const targetUrl = required("NUCLEUS_EVAL_TARGET_URL");
const callbackUrl = required("NUCLEUS_EVAL_CALLBACK_URL");
const callbackToken = required("NUCLEUS_RUNNER_CALLBACK_TOKEN");
const viewportName = process.env.NUCLEUS_EVAL_VIEWPORT === "mobile" ? "mobile" : "desktop";
const viewport = viewportName === "mobile" ? { width: 390, height: 844 } : { width: 960, height: 720 };
const consoleEntries = [];
const pageErrors = [];
const failedRequests = [];
const steps = [];
let browser;
let status = "failed";
let result;

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport, colorScheme: "light" });
  const page = await context.newPage();
  page.on("console", (entry) => {
    if (["warning", "error"].includes(entry.type())) consoleEntries.push({ type: entry.type(), text: entry.text().slice(0, 2_000) });
  });
  page.on("pageerror", (error) => pageErrors.push({ message: error.message.slice(0, 2_000), stack: error.stack?.slice(0, 5_000) ?? null }));
  page.on("requestfailed", (request) => failedRequests.push({ url: request.url().slice(0, 500), method: request.method(), error: request.failure()?.errorText ?? "request failed" }));

  const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  steps.push({ action: "navigate", ok: Boolean(response?.ok()), status: response?.status() ?? null, url: page.url() });
  await page.waitForTimeout(1_200);
  const bodyText = (await page.locator("body").innerText()).trim();
  const title = await page.title();
  const controls = page.locator("button, a[href], input, select, textarea, [role=button]");
  const controlCount = await controls.count();
  steps.push({ action: "startup", ok: bodyText.length > 0, title, bodyChars: bodyText.length, controlCount });

  const textInput = page.locator("input:not([type=password]):not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea").filter({ visible: true }).first();
  if (await textInput.count()) {
    await textInput.fill("Nucleus cloud acceptance").catch(() => undefined);
    steps.push({ action: "fill", ok: true, target: await accessibleName(textInput) });
  }

  const buttons = page.locator("button:visible, [role=button]:visible");
  const buttonCount = Math.min(await buttons.count(), 8);
  for (let index = 0; index < buttonCount; index += 1) {
    const button = buttons.nth(index);
    const name = (await accessibleName(button)).toLowerCase();
    if (!name || /删除|移除|付款|购买|退出|注销|发布|delete|remove|pay|purchase|logout|sign out|publish/.test(name)) continue;
    const disabled = await button.isDisabled().catch(() => true);
    if (disabled) continue;
    const beforeUrl = page.url();
    await button.click({ timeout: 3_000 }).then(() => steps.push({ action: "click", ok: true, target: name.slice(0, 120) })).catch((error) => steps.push({ action: "click", ok: false, target: name.slice(0, 120), error: error.message.slice(0, 300) }));
    await page.waitForTimeout(220);
    if (page.url() !== beforeUrl && !page.url().startsWith(new URL(targetUrl).origin)) await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  }

  const screenshot = await page.screenshot({ type: "jpeg", quality: 24, fullPage: false });
  await mkdir("test-results/cloud-eval", { recursive: true });
  await writeFile("test-results/cloud-eval/screenshot.jpg", screenshot);
  const screenshotBase64 = screenshot.length <= 95_000 ? screenshot.toString("base64") : null;
  const blockingErrors = [...pageErrors, ...consoleEntries.filter((entry) => entry.type === "error")];
  status = bodyText.length > 0 && blockingErrors.length === 0 && steps.every((step) => step.ok !== false) ? "passed" : "failed";
  result = {
    summary: status === "passed" ? `Playwright 已完成 ${steps.length} 个真实浏览器步骤，未发现阻断错误` : `Playwright 发现 ${blockingErrors.length} 个运行错误或失败步骤`,
    targetUrl,
    viewport,
    title,
    steps,
    console: consoleEntries.slice(0, 80),
    pageErrors: pageErrors.slice(0, 30),
    failedRequests: failedRequests.slice(0, 30),
    screenshot: screenshotBase64 ? `data:image/jpeg;base64,${screenshotBase64}` : null,
    screenshotSha256: createHash("sha256").update(screenshot).digest("hex"),
    screenshotBytes: screenshot.length,
    evaluatedAt: new Date().toISOString(),
  };
} catch (error) {
  result = {
    summary: `Playwright Runner 自身失败：${error instanceof Error ? error.message : String(error)}`,
    targetUrl,
    viewport,
    steps,
    console: consoleEntries.slice(0, 80),
    pageErrors: pageErrors.slice(0, 30),
    failedRequests: failedRequests.slice(0, 30),
    evaluatedAt: new Date().toISOString(),
  };
} finally {
  await browser?.close().catch(() => undefined);
}

await mkdir("test-results/cloud-eval", { recursive: true });
await writeFile("test-results/cloud-eval/result.json", `${JSON.stringify({ jobId, status, result }, null, 2)}\n`);
const callback = await fetch(callbackUrl, {
  method: "POST",
  headers: { Authorization: `Bearer ${callbackToken}`, "Content-Type": "application/json" },
  body: JSON.stringify({ jobId, status, result }),
});
if (!callback.ok) throw new Error(`Runner callback failed: ${callback.status} ${(await callback.text()).slice(0, 500)}`);
if (status !== "passed") process.exitCode = 1;

async function accessibleName(locator) {
  return (await locator.getAttribute("aria-label")) || (await locator.innerText().catch(() => "")) || (await locator.getAttribute("placeholder")) || "unnamed control";
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
