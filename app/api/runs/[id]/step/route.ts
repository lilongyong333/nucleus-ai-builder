import { acquireGenerationStep, getProject, incrementGenerationRepair, listGenerationArtifacts, markError, recordModelAttempts, recordNextGenerationEvent, recordRaceCandidates, releaseGenerationStep, saveGeneration, saveGenerationArtifact, updateGenerationStage, type GenerationMetrics } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { ModelGatewayError, type ModelAttempt } from "@/lib/model-gateway";
import { AgentOutputError, createStepBudget, deterministicBobResult, deterministicIrisResult, deterministicRayResult, generationBudgetLimits, runAlexFileAgent, runAlexFileRaceAgent, runBobAgent, runIrisAgent, runRayRepairAgent, runRayReviewAgent, type AgentModelResult, type ArchitectureArtifact, type RayReviewArtifact } from "@/lib/opencode";
import { normalizeGeneratedFiles } from "@/lib/runtime";
import { projectOrganizationRole } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";
import type { AgentAudit, AgentEvent, AgentName, AgentPlan, GeneratedFiles, GenerationArtifact, GenerationArtifactKind, GenerationStage, ModelUsage } from "@/lib/types";
import { scheduleProjectDatabaseProvisioning } from "@/lib/background-tasks";

export const maxDuration = 60;

class TerminalWorkflowError extends Error {}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const visitor = resolveVisitorSession(request);
  let identity;
  try {
    identity = await resolveWorkspaceIdentity(request, visitor);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "工作区身份解析失败" }, { status: 500 }), visitor);
  }
  const { id: runId } = await context.params;
  let body: { projectId?: string };
  try {
    body = await request.json();
  } catch {
    return withWorkspaceIdentity(Response.json({ error: "请求格式错误" }, { status: 400 }), identity);
  }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  if (!projectId) return withWorkspaceIdentity(Response.json({ error: "缺少项目 ID" }, { status: 400 }), identity);
  const project = await getProject(projectId, identity.ownerId);
  const run = project?.runs.find((item) => item.id === runId);
  if (!project || !run) return withWorkspaceIdentity(Response.json({ error: "Run 不存在或无权访问" }, { status: 404 }), identity);
  const role = await projectOrganizationRole(projectId, identity.ownerId);
  if (!role || !["owner", "admin", "editor"].includes(role)) return withWorkspaceIdentity(Response.json({ error: "当前组织角色不能执行生成步骤" }, { status: 403 }), identity);
  if (run.status !== "running" || project.status !== "generating") return withWorkspaceIdentity(Response.json({ error: "Run 已结束", project }, { status: 409 }), identity);
  const stepToken = await acquireGenerationStep(projectId, identity.ownerId, runId);
  if (!stepToken) return withWorkspaceIdentity(Response.json({ error: "当前阶段正在执行，请稍后同步", retryable: true }, { status: 409, headers: { "Retry-After": "2" } }), identity);

  const encoder = new TextEncoder();
  const abortController = new AbortController();
  request.signal.addEventListener("abort", () => abortController.abort(new DOMException("Browser connection closed", "AbortError")), { once: true });
  const stream = new ReadableStream({
    start(controller) {
      void (async () => {
        const deadline = setTimeout(() => abortController.abort(new DOMException("Stage deadline exceeded", "TimeoutError")), 54_000);
        const heartbeat = setInterval(() => {
          if (!abortController.signal.aborted) controller.enqueue(encoder.encode("\n"));
        }, 8_000);
        const emit = (event: AgentEvent) => {
          if (!abortController.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        const auditFrom = (event: Awaited<ReturnType<typeof recordNextGenerationEvent>>): AgentAudit => ({
          runId: event.runId,
          eventId: event.id,
          phase: event.phase,
          sequence: event.sequence,
          ...(event.durationMs === null ? {} : { durationMs: event.durationMs }),
          ...(event.model ? { model: event.model } : {}),
          ...(event.usage.totalTokens > 0 ? { usage: event.usage } : {}),
        });
        const status = async (agent: AgentName, phase: string, title: string, detail: string, state: "working" | "done", options: { durationMs?: number; usage?: ModelUsage; model?: string } = {}) => {
          const saved = await recordNextGenerationEvent(runId, projectId, { agent, phase, title, detail, state, ...options });
          emit({ type: "status", agent, title, detail, state, audit: auditFrom(saved) });
        };
        const reportProgress = (progress: Parameters<NonNullable<Parameters<typeof runIrisAgent>[4]>>[0]) => emit({ type: "progress", ...progress });
        let stage = run.currentStage;
        let agent = agentFor(stage);
        try {
          const runLimits = generationBudgetLimits();
          const modelBudget = () => {
            const remainingCalls = runLimits.maxCalls - run.modelCalls;
            const remainingTokens = runLimits.maxTotalTokens - run.usage.totalTokens;
            if (remainingCalls < 1) throw new TerminalWorkflowError(`Run 已使用 ${run.modelCalls}/${runLimits.maxCalls} 次模型调用，达到审计预算上限`);
            if (remainingTokens < 1_000) throw new TerminalWorkflowError(`Run 已使用 ${run.usage.totalTokens}/${runLimits.maxTotalTokens} Tokens，达到审计预算上限`);
            return createStepBudget({ maxCalls: remainingCalls, maxTotalTokens: remainingTokens });
          };
          const artifacts = await listGenerationArtifacts(runId, projectId);
          const artifactMap = new Map(artifacts.map((artifact) => [artifact.kind, artifact]));
          stage = normalizeStage(stage, artifactMap);
          agent = agentFor(stage);
          await updateGenerationStage(runId, projectId, stage);

          if (stage === "requirements") {
            await status("Iris", stage, "提炼需求契约", "正在把自然语言转为可逐项验收的产品工件", "working");
            const result = await withDeterministicRecovery(
              () => runIrisAgent(run.prompt, project.currentVersionId ? project.files : undefined, abortController.signal, modelBudget(), reportProgress),
              (reason) => deterministicIrisResult(run.prompt, project.currentVersionId ? project.files : undefined, reason),
            );
            await persistResult(runId, projectId, "Iris", stage, result);
            await recordRecovery(runId, projectId, "Iris", stage, result, emit);
            const artifact = await saveGenerationArtifact(runId, projectId, "Iris", "requirements", JSON.stringify(result.artifact));
            await status("Iris", stage, "需求工件完成", `${result.artifact.features.length} 个功能 · ${result.artifact.acceptanceCriteria?.length ?? 0} 条验收标准`, "done", result);
            emit({ type: "plan", plan: result.artifact });
            emit({ type: "artifact", artifact });
            await finishStep(runId, projectId, stage, "architecture", emit);
          } else if (stage === "architecture") {
            const plan = parseArtifact<AgentPlan>(artifactMap, "requirements");
            await status("Bob", stage, "设计实现架构", "正在建立状态模型、文件职责、交互流和测试策略", "working");
            const result = await withDeterministicRecovery(
              () => runBobAgent(run.prompt, plan, project.currentVersionId ? project.files : undefined, abortController.signal, modelBudget(), reportProgress),
              (reason) => deterministicBobResult(run.prompt, plan, reason),
            );
            await persistResult(runId, projectId, "Bob", stage, result);
            await recordRecovery(runId, projectId, "Bob", stage, result, emit);
            const artifact = await saveGenerationArtifact(runId, projectId, "Bob", "architecture", JSON.stringify(result.artifact));
            const manifestArtifact = await saveGenerationArtifact(runId, projectId, "Bob", "manifest", JSON.stringify(result.artifact.runtime));
            await status("Bob", stage, "架构工件完成", `${result.artifact.stateModel.length} 个状态约束 · ${result.artifact.testPlan.length} 条测试策略`, "done", result);
            emit({ type: "artifact", artifact });
            emit({ type: "artifact", artifact: manifestArtifact });
            await finishStep(runId, projectId, stage, "implementation:index.html", emit);
          } else if (stage.startsWith("implementation:")) {
            const path = stage.slice("implementation:".length) as keyof GeneratedFiles;
            const plan = parseArtifact<AgentPlan>(artifactMap, "requirements");
            const architecture = parseArtifact<ArchitectureArtifact>(artifactMap, "architecture");
            const partial = filesFromArtifacts(artifactMap, false);
            await status("Alex", stage, `生成 ${path}`, architecture.fileResponsibilities[path], "working");
            const race = run.mode === "race"
              ? await runAlexFileRaceAgent(path, run.prompt, plan, architecture, partial, project.currentVersionId ? project.files : undefined, abortController.signal, modelBudget, reportProgress)
              : null;
            const result = race?.result ?? await runAlexFileAgent(path, run.prompt, plan, architecture, partial, project.currentVersionId ? project.files : undefined, abortController.signal, modelBudget(), reportProgress);
            await persistResult(runId, projectId, "Alex", stage, result);
            if (race) {
              await recordRaceCandidates(runId, projectId, stage, race.candidates);
              await status("Alex", `${stage}:race`, "Race Mode 已择优", `${race.candidates.length} 个模型并行候选 · 选中 ${result.model}`, "done", result);
            }
            const artifact = await saveGenerationArtifact(runId, projectId, "Alex", path, result.artifact);
            await status("Alex", stage, `${path} 已保存`, `${Math.max(1, Math.round(result.artifact.length / 1000))} KB · 已建立断点`, "done", result);
            emit({ type: "file", path, size: result.artifact.length });
            emit({ type: "artifact", artifact });
            const next = path === "index.html" ? "implementation:styles.css" : path === "styles.css" ? "implementation:script.js" : "quality";
            await finishStep(runId, projectId, stage, next, emit);
          } else if (stage === "quality") {
            const plan = parseArtifact<AgentPlan>(artifactMap, "requirements");
            const architecture = parseArtifact<ArchitectureArtifact>(artifactMap, "architecture");
            const files = normalizeGeneratedFiles(filesFromArtifacts(artifactMap, true));
            await status("Ray", stage, "执行交付审查", "正在结合确定性检查、验收标准和代码证据做最终审查", "working");
            const result = await withDeterministicRecovery(
              () => runRayReviewAgent(run.prompt, plan, architecture, files, abortController.signal, modelBudget(), reportProgress),
              (reason) => deterministicRayResult(run.prompt, plan, files, reason),
            );
            await persistResult(runId, projectId, "Ray", stage, result);
            await recordRecovery(runId, projectId, "Ray", stage, result, emit);
            const artifact = await saveGenerationArtifact(runId, projectId, "Ray", "quality", JSON.stringify(result.artifact));
            emit({ type: "review", report: result.artifact.deterministic });
            emit({ type: "artifact", artifact });
            if (!result.artifact.passed && run.repairCount >= 2) throw new TerminalWorkflowError(`Ray 在 ${run.repairCount} 轮修复后仍发现阻断问题：${result.artifact.issues.filter((issue) => issue.severity === "error").map((issue) => issue.detail).join("；").slice(0, 500)}`);
            const next = result.artifact.passed ? "finalize" : "repair";
            await status("Ray", stage, result.artifact.passed ? "质量门通过" : "发现可修复问题", result.artifact.passed ? `${result.artifact.functionalChecks.length} 条功能证据 · ${result.artifact.deterministic.score}/100` : `${result.artifact.issues.filter((issue) => issue.severity === "error").length} 个阻断问题，进入修复`, "done", result);
            await finishStep(runId, projectId, stage, next, emit);
          } else if (stage === "repair") {
            const plan = parseArtifact<AgentPlan>(artifactMap, "requirements");
            const architecture = parseArtifact<ArchitectureArtifact>(artifactMap, "architecture");
            const review = parseArtifact<RayReviewArtifact>(artifactMap, "quality");
            const files = normalizeGeneratedFiles(filesFromArtifacts(artifactMap, true));
            await status("Ray", stage, "修复质量问题", `第 ${run.repairCount + 1} 轮定向修复，只改动有证据的问题`, "working");
            const result = await runRayRepairAgent(run.prompt, plan, architecture, review, files, abortController.signal, modelBudget(), reportProgress);
            await persistResult(runId, projectId, "Ray", stage, result);
            for (const [path, content] of Object.entries(result.artifact) as Array<[keyof GeneratedFiles, string]>) {
              const artifact = await saveGenerationArtifact(runId, projectId, "Ray", path, content);
              emit({ type: "file", path, size: content.length });
              emit({ type: "artifact", artifact });
            }
            await incrementGenerationRepair(runId, projectId);
            await status("Ray", stage, "修复工件已保存", `${Object.keys(result.artifact).length} 个文件已更新，重新执行全部质量检查`, "done", result);
            await finishStep(runId, projectId, stage, "quality", emit);
          } else if (stage === "finalize") {
            const plan = parseArtifact<AgentPlan>(artifactMap, "requirements");
            const architecture = parseArtifact<ArchitectureArtifact>(artifactMap, "architecture");
            const review = parseArtifact<RayReviewArtifact>(artifactMap, "quality");
            if (!review.passed) throw new TerminalWorkflowError("最后一次 Ray 审查尚未通过，拒绝保存版本");
            const files = normalizeGeneratedFiles(filesFromArtifacts(artifactMap, true));
            const freshProject = await getProject(projectId, identity.ownerId);
            const freshRun = freshProject?.runs.find((item) => item.id === runId);
            if (!freshProject || !freshRun) throw new TerminalWorkflowError("保存版本前无法恢复 Run 审计");
            await status("Ray", stage, "保存可回滚版本", "所有 Agent 工件和质量证据已齐备，正在原子提交", "working");
            const metrics: GenerationMetrics = { usage: freshRun.usage, modelCalls: freshRun.modelCalls, repairCount: freshRun.repairCount, durationMs: Date.now() - Date.parse(freshRun.startedAt), model: freshRun.model };
            const quality = { ...review.deterministic, summary: `${review.summary}；${review.functionalChecks.filter((item) => item.passed).length}/${review.functionalChecks.length || 0} 条功能证据通过` };
            const saved = await saveGeneration(projectId, identity.ownerId, runId, plan, files, review.summary || `完成 ${plan.appName}`, freshRun.model, quality, metrics, architecture.runtime);
            scheduleProjectDatabaseProvisioning(projectId);
            emit({ type: "complete", project: saved });
          } else {
            const fresh = await getProject(projectId, identity.ownerId);
            if (fresh) emit({ type: "complete", project: fresh });
          }
        } catch (error) {
          const errorAttempts = attemptsFromError(error);
          if (errorAttempts.length) await recordModelAttempts(runId, projectId, agent, stage, errorAttempts.map(toPersistedAttempt)).catch(() => undefined);
          if (abortController.signal.aborted) return;
          const message = friendlyError(error, stage);
          const previousFailures = run.events.filter((event) => event.phase === `${stage}:failure` && event.state === "error").length;
          const terminal = error instanceof TerminalWorkflowError || (error instanceof ModelGatewayError && error.kind === "budget") || previousFailures >= 2;
          let audit: AgentAudit | undefined;
          try {
            const failed = await recordNextGenerationEvent(runId, projectId, { agent, phase: `${stage}:failure`, title: terminal ? "阶段失败" : "阶段重试", detail: message, state: "error" });
            audit = auditFrom(failed);
          } catch { /* the user may have cancelled while the provider was returning */ }
          if (terminal) {
            const fresh = await getProject(projectId, identity.ownerId);
            const freshRun = fresh?.runs.find((item) => item.id === runId) ?? run;
            const metrics: GenerationMetrics = { usage: freshRun.usage, modelCalls: freshRun.modelCalls, repairCount: freshRun.repairCount, durationMs: Date.now() - Date.parse(freshRun.startedAt), model: freshRun.model };
            await markError(projectId, identity.ownerId, runId, message, metrics).catch(() => undefined);
          }
          emit({ type: "error", message, retryable: !terminal, stage, ...(audit ? { audit } : {}) });
        } finally {
          clearInterval(heartbeat);
          clearTimeout(deadline);
          await releaseGenerationStep(runId, stepToken).catch(() => undefined);
          if (!abortController.signal.aborted) controller.close();
        }
      })();
    },
    cancel() {
      abortController.abort(new DOMException("Browser cancelled the stage stream", "AbortError"));
    },
  });
  return withWorkspaceIdentity(new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } }), identity);
}

async function persistResult<T>(runId: string, projectId: string, agent: AgentName, phase: string, result: AgentModelResult<T>) {
  await recordModelAttempts(runId, projectId, agent, phase, result.attempts.map(toPersistedAttempt));
}

async function recordRecovery<T>(runId: string, projectId: string, agent: AgentName, phase: string, result: AgentModelResult<T>, emit: (event: AgentEvent) => void) {
  if (!result.recovery) return;
  const saved = await recordNextGenerationEvent(runId, projectId, {
    agent,
    phase: `${phase}:recovery`,
    title: `${agent} 已启用确定性恢复`,
    detail: `${result.recovery.reason.slice(0, 360)}；工作流继续执行，最终仍须通过代码协议与质量门。`,
    state: "done",
    model: result.model,
  });
  emit({ type: "status", agent, title: saved.title, detail: saved.detail, state: "done", audit: { runId: saved.runId, eventId: saved.id, phase: saved.phase, sequence: saved.sequence, model: result.model } });
}

async function withDeterministicRecovery<T>(execute: () => Promise<AgentModelResult<T>>, recover: (reason: string) => AgentModelResult<T>): Promise<AgentModelResult<T>> {
  try {
    return await execute();
  } catch (error) {
    if (!isRecoverablePlanningError(error)) throw error;
    const attempts = attemptsFromError(error);
    const recovered = recover(error instanceof Error ? error.message : "模型没有形成可用工件");
    return {
      ...recovered,
      attempts,
      usage: attempts.reduce((total, item) => ({ promptTokens: total.promptTokens + item.usage.promptTokens, completionTokens: total.completionTokens + item.usage.completionTokens, totalTokens: total.totalTokens + item.usage.totalTokens }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
      modelCalls: attempts.length,
      model: [...new Set([...attempts.map((item) => item.model), recovered.model])].join(" → "),
    };
  }
}

function isRecoverablePlanningError(error: unknown): boolean {
  if (error instanceof AgentOutputError) return true;
  if (!(error instanceof ModelGatewayError) || error.kind !== "provider") return false;
  const finalAttempt = error.attempts.at(-1);
  return Boolean(finalAttempt && ["empty", "incomplete", "timeout", "network_error"].includes(finalAttempt.status));
}

function toPersistedAttempt(attempt: ModelAttempt) {
  return { model: attempt.model, status: attempt.status, durationMs: attempt.durationMs, firstTokenMs: attempt.firstTokenMs, outputChars: attempt.outputChars, statusCode: attempt.statusCode, usage: attempt.usage, error: attempt.error };
}

async function finishStep(runId: string, projectId: string, stage: GenerationStage, nextStage: GenerationStage, emit: (event: AgentEvent) => void) {
  await updateGenerationStage(runId, projectId, nextStage);
  emit({ type: "step_complete", runId, stage, nextStage, terminal: nextStage === "completed" });
}

function parseArtifact<T>(artifacts: Map<GenerationArtifactKind, GenerationArtifact>, kind: GenerationArtifactKind): T {
  const artifact = artifacts.get(kind);
  if (!artifact) throw new TerminalWorkflowError(`缺少 ${kind} 工件，无法继续交接`);
  try {
    return JSON.parse(artifact.content) as T;
  } catch {
    throw new TerminalWorkflowError(`${kind} 工件已损坏，无法解析`);
  }
}

function filesFromArtifacts(artifacts: Map<GenerationArtifactKind, GenerationArtifact>, requireAll: boolean): Partial<GeneratedFiles> {
  const files: Partial<GeneratedFiles> = {};
  for (const path of ["index.html", "styles.css", "script.js"] as const) {
    const artifact = artifacts.get(path);
    if (artifact) files[path] = artifact.content;
    else if (requireAll) throw new TerminalWorkflowError(`缺少 ${path} 工件`);
  }
  return files;
}

function normalizeStage(stage: GenerationStage, artifacts: Map<GenerationArtifactKind, GenerationArtifact>): GenerationStage {
  if (stage === "requirements" && artifacts.has("requirements")) return "architecture";
  if (stage === "architecture" && artifacts.has("architecture")) return "implementation:index.html";
  if (stage === "implementation:index.html" && artifacts.has("index.html")) return "implementation:styles.css";
  if (stage === "implementation:styles.css" && artifacts.has("styles.css")) return "implementation:script.js";
  if (stage === "implementation:script.js" && artifacts.has("script.js")) return "quality";
  return stage;
}

function agentFor(stage: GenerationStage): AgentName {
  if (stage === "requirements") return "Iris";
  if (stage === "architecture") return "Bob";
  if (stage.startsWith("implementation:")) return "Alex";
  return "Ray";
}

function attemptsFromError(error: unknown): ModelAttempt[] {
  if (error instanceof AgentOutputError) return error.result.attempts;
  if (error instanceof ModelGatewayError) return error.attempts;
  return [];
}

function friendlyError(error: unknown, stage: GenerationStage): string {
  const raw = error instanceof Error ? error.message : "未知错误";
  if (/time budget|timed out|deadline/i.test(raw)) return `${stage} 阶段的模型在本次窗口内没有完成，系统已保留此前工件并准备重试或切换备用模型。`;
  if (/empty/i.test(raw)) return `${stage} 阶段收到空响应，系统已保留此前工件并准备换模型重试。`;
  return raw.slice(0, 600);
}
