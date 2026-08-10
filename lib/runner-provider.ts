import { env } from "cloudflare:workers";
import { completeRunnerJob, markRunnerJobRunning, recordRuntimeEvidence } from "./app-platform-db";
import type { AppManifest, GeneratedFiles, RunnerJob } from "./types";
import { buildSandboxContract, SandboxPolicyError, signRunnerPayload } from "./sandbox-policy";
import { createInstallationAccessToken } from "./github-app";

export class RunnerProviderError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "RunnerProviderError";
  }
}

export async function dispatchPlaywrightJob(job: RunnerJob, callbackOrigin: string): Promise<RunnerJob> {
  if (job.kind !== "playwright") throw new RunnerProviderError("Runner 类型不匹配", 400);
  if (job.status !== "queued") return job;
  const runtime = env as unknown as Record<string, unknown>;
  const installationId = stringValue(runtime.GITHUB_RUNNER_INSTALLATION_ID);
  const token = stringValue(runtime.GITHUB_AUTOMATION_TOKEN) || (installationId ? await createInstallationAccessToken(installationId) : "");
  const repository = stringValue(runtime.GITHUB_RUNNER_REPOSITORY);
  const ref = stringValue(runtime.GITHUB_RUNNER_REF) || "main";
  if (!token || !repository || !stringValue(runtime.NUCLEUS_RUNNER_CALLBACK_TOKEN)) throw new RunnerProviderError("云端 Playwright Runner 尚未完成服务端配置", 409);
  const match = repository.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (!match) throw new RunnerProviderError("GITHUB_RUNNER_REPOSITORY 格式无效", 500);
  const response = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}/actions/workflows/generated-app-eval.yml/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "Nucleus-AI-Builder",
    },
    body: JSON.stringify({
      ref,
      inputs: {
        job_id: job.id,
        target_url: typeof job.request.publicUrl === "string" ? job.request.publicUrl : "",
        callback_url: `${callbackOrigin.replace(/\/$/, "")}/api/runner/callback`,
        viewport: typeof job.request.viewport === "string" ? job.request.viewport : "desktop",
      },
    }),
  });
  if (response.status !== 204) {
    const body = await response.text();
    await completeRunnerJob(job.id, "failed", { message: `GitHub workflow dispatch failed (${response.status})`, detail: body.slice(0, 1_000) });
    throw new RunnerProviderError(`GitHub Actions 触发失败：${response.status}`, 502);
  }
  return await markRunnerJobRunning(job.id) ?? job;
}

export async function dispatchContainerJob(job: RunnerJob, callbackOrigin: string, artifact: { files: GeneratedFiles; manifest: AppManifest }): Promise<RunnerJob> {
  if (job.kind !== "container-build") throw new RunnerProviderError("Runner 类型不匹配", 400);
  if (job.status !== "queued") return job;
  const runtime = env as unknown as Record<string, unknown>;
  const endpoint = stringValue(runtime.NUCLEUS_CONTAINER_RUNNER_URL);
  const providerToken = stringValue(runtime.NUCLEUS_CONTAINER_RUNNER_TOKEN);
  const callbackToken = stringValue(runtime.NUCLEUS_RUNNER_CALLBACK_TOKEN);
  if (!endpoint || !providerToken || !callbackToken) throw new RunnerProviderError("外部容器 Runner 尚未完成服务端配置", 409);
  let target: URL;
  try { target = new URL(endpoint); } catch { throw new RunnerProviderError("NUCLEUS_CONTAINER_RUNNER_URL 格式无效", 500); }
  if (target.protocol !== "https:" && target.hostname !== "localhost" && target.hostname !== "127.0.0.1") throw new RunnerProviderError("容器 Runner 必须使用 HTTPS", 500);
  const allowedRegistries = stringValue(runtime.NUCLEUS_ALLOWED_CONTAINER_REGISTRIES).split(",").map((item) => item.trim()).filter(Boolean);
  let contract;
  try {
    contract = await buildSandboxContract(artifact.files, artifact.manifest, allowedRegistries);
  } catch (error) {
    if (error instanceof SandboxPolicyError) {
      await completeRunnerJob(job.id, "failed", { message: error.message, policyRule: error.rule });
      throw new RunnerProviderError(error.message, 422);
    }
    throw error;
  }
  const payload = JSON.stringify({
    jobId: job.id,
    projectId: job.projectId,
    versionId: job.versionId,
    files: artifact.files,
    dependencies: artifact.manifest.dependencies,
    functions: artifact.manifest.backend.functions,
    callback: { url: `${callbackOrigin.replace(/\/$/, "")}/api/runner/callback`, bearerToken: callbackToken },
    contract,
  });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = await signRunnerPayload(payload, providerToken, timestamp);
  const response = await fetch(target, {
    method: "POST",
    headers: { Authorization: `Bearer ${providerToken}`, "Content-Type": "application/json", "User-Agent": "Nucleus-AI-Builder", "X-Nucleus-Timestamp": timestamp, "X-Nucleus-Signature": `v1=${signature}` },
    body: payload,
  });
  if (!response.ok) {
    const detail = await response.text();
    await completeRunnerJob(job.id, "failed", { message: `Container runner dispatch failed (${response.status})`, detail: detail.slice(0, 1_000) });
    throw new RunnerProviderError(`容器 Runner 触发失败：${response.status}`, 502);
  }
  return await markRunnerJobRunning(job.id) ?? job;
}

export async function acceptRunnerCallback(request: Request): Promise<RunnerJob> {
  const runtime = env as unknown as Record<string, unknown>;
  const expected = stringValue(runtime.NUCLEUS_RUNNER_CALLBACK_TOKEN);
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!expected || !await equalSecret(expected, supplied)) throw new RunnerProviderError("Runner callback 未授权", 401);
  const body = await request.json() as { jobId?: string; status?: "passed" | "failed"; result?: Record<string, unknown> };
  if (typeof body.jobId !== "string" || (body.status !== "passed" && body.status !== "failed")) throw new RunnerProviderError("Runner callback 格式错误", 400);
  const result = body.result && typeof body.result === "object" ? body.result : {};
  const job = await completeRunnerJob(body.jobId, body.status, result);
  if (!job) throw new RunnerProviderError("Runner Job 不存在", 404);
  const summary = typeof result.summary === "string" ? result.summary : job.kind === "playwright"
    ? body.status === "passed" ? "云端 Playwright 验收通过" : "云端 Playwright 验收失败"
    : body.status === "passed" ? "外部容器构建与运行通过" : "外部容器构建或运行失败";
  await recordRuntimeEvidence({
    projectId: job.projectId,
    versionId: job.versionId,
    source: job.kind === "playwright" ? "browser-runner" : "api",
    level: body.status === "passed" ? "info" : "error",
    message: summary,
    evidence: { jobId: job.id, ...result },
  });
  return job;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  if (av.length !== bv.length) return false;
  let difference = 0;
  for (let index = 0; index < av.length; index += 1) difference |= av[index] ^ bv[index];
  return difference === 0;
}
