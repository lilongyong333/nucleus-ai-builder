import { beginGeneration, consumeGenerationQuota, getProject, markError, recordGenerationEvent, releaseGeneration, saveGeneration, type GenerationMetrics } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity, type WorkspaceIdentity } from "@/lib/identity";
import { activeModel, buildApp, createPlan } from "@/lib/opencode";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";
import { addUsage, emptyUsage } from "@/lib/usage";
import type { AgentAudit, AgentEvent, ModelUsage, Project } from "@/lib/types";

export const maxDuration = 300;

export async function POST(request: Request) {
  const visitor = resolveVisitorSession(request);
  let identity: WorkspaceIdentity;
  try { identity = await resolveWorkspaceIdentity(request, visitor); }
  catch (error) { return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "工作区身份解析失败" }, { status: 500 }), visitor); }
  let body: { projectId?: string; prompt?: string };
  try { body = await request.json(); } catch { return withWorkspaceIdentity(Response.json({ error: "请求格式错误" }, { status: 400 }), identity); }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!projectId || prompt.length < 3) return withWorkspaceIdentity(Response.json({ error: "项目和需求不能为空" }, { status: 400 }), identity);

  const model = activeModel();
  const runStartedAt = Date.now();
  let project: Project | null = null;
  let generationId = "";
  try {
    project = await getProject(projectId, identity.ownerId);
    if (!project) return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    const lease = await beginGeneration(projectId, identity.ownerId, prompt, model);
    if (!lease) return withWorkspaceIdentity(Response.json({ error: "这个项目正在生成，请等待当前任务完成" }, { status: 409 }), identity);
    generationId = lease;
    const clientIdentifier = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? identity.ownerId;
    if (!(await consumeGenerationQuota(clientIdentifier))) {
      await releaseGeneration(projectId, identity.ownerId, generationId, project.versions.length > 0 ? "ready" : "draft", "本小时生成配额已用完");
      return withWorkspaceIdentity(Response.json({ error: "本小时生成次数已达上限，请稍后再试" }, { status: 429, headers: { "Retry-After": "3600" } }), identity);
    }
  } catch (error) {
    if (generationId) await releaseGeneration(projectId, identity.ownerId, generationId, project?.versions.length ? "ready" : "draft", error instanceof Error ? error.message : "生成准备失败").catch(() => undefined);
    return withWorkspaceIdentity(Response.json({ error: error instanceof Error ? error.message : "生成准备失败" }, { status: 500 }), identity);
  }
  if (!project || !generationId) return withWorkspaceIdentity(Response.json({ error: "生成准备失败" }, { status: 500 }), identity);

  const activeProject = project;
  const activeGenerationId = generationId;
  const generationAbort = new AbortController();
  request.signal.addEventListener("abort", () => generationAbort.abort(), { once: true });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let sequence = 0;
      let usage: ModelUsage = emptyUsage();
      let modelCalls = 0;
      let repairCount = 0;
      const metrics = (): GenerationMetrics => ({ usage, modelCalls, repairCount, durationMs: Date.now() - runStartedAt });
      const emit = (event: AgentEvent) => {
        if (!generationAbort.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const auditFrom = (event: Awaited<ReturnType<typeof recordGenerationEvent>>): AgentAudit => ({
        runId: event.runId,
        eventId: event.id,
        phase: event.phase,
        sequence: event.sequence,
        ...(event.durationMs === null ? {} : { durationMs: event.durationMs }),
        ...(event.model ? { model: event.model } : {}),
        ...(event.usage.totalTokens > 0 ? { usage: event.usage } : {}),
      });
      const status = async (agent: string, phase: string, title: string, detail: string, state: "working" | "done", options: { durationMs?: number; usage?: ModelUsage; model?: string } = {}) => {
        const event = await recordGenerationEvent(activeGenerationId, projectId, { sequence: ++sequence, agent, phase, title, detail, state, ...options });
        const audit = auditFrom(event);
        emit({ type: "status", agent, title, detail, state, audit });
        return audit;
      };
      const file = async (path: "index.html" | "styles.css" | "script.js", size: number) => {
        const detail = `${Math.max(1, Math.round(size / 1000))} KB · 已写入交付工件`;
        const event = await recordGenerationEvent(activeGenerationId, projectId, { sequence: ++sequence, agent: "Alex", phase: `artifact:${path}`, title: `写入 ${path}`, detail, state: "done" });
        emit({ type: "file", path, size, audit: auditFrom(event) });
      };

      try {
        await status("Iris", "requirements", "理解需求", "正在梳理用户目标和使用场景", "working");
        const hasGeneratedVersion = activeProject.versions.length > 0;
        const planResult = await createPlan(prompt, hasGeneratedVersion ? activeProject.files : undefined, generationAbort.signal);
        usage = addUsage(usage, planResult.usage);
        modelCalls += planResult.modelCalls;
        const planAudit = await status("Iris", "requirements", "需求分析完成", `${planResult.plan.features.length} 个可验证功能`, "done", { durationMs: planResult.durationMs, usage: planResult.usage, model });
        emit({ type: "plan", plan: planResult.plan, audit: planAudit });

        await status("Bob", "architecture", "设计实现方案", planResult.plan.design, "working");
        await status("Bob", "architecture", "架构确认", "HTML / CSS / JavaScript 三文件应用", "done");
        await status("Alex", "implementation", "生成应用", "正在实现页面、样式和交互", "working");

        const result = await buildApp(prompt, planResult.plan, hasGeneratedVersion ? activeProject.files : undefined, generationAbort.signal);
        usage = addUsage(usage, result.usage);
        modelCalls += result.modelCalls;
        repairCount += result.repairCount;
        for (const path of ["index.html", "styles.css", "script.js"] as const) await file(path, result.files[path].length);
        await status("Alex", "implementation", "代码完成", `3 个文件已生成 · ${result.modelCalls} 次模型调用`, "done", { durationMs: result.durationMs, usage: result.usage, model });
        const reviewAudit = await status("Ray", "quality", "交付检查", `执行 9 项确定性检查${result.repairCount ? ` · 自动修复 ${result.repairCount} 次` : ""}`, "working");
        emit({ type: "review", report: result.quality, audit: reviewAudit });
        await status("Ray", "quality", `质量门 ${result.quality.grade} 级`, `${result.quality.score}/100 · 检查通过，正在保存版本`, "done");

        const saved = await saveGeneration(projectId, identity.ownerId, activeGenerationId, planResult.plan, result.files, result.summary, model, result.quality, metrics());
        emit({ type: "status", agent: "Ray", title: "版本已保存", detail: `${usage.totalTokens || "未返回"} tokens · 可回滚、分享和下载`, state: "done" });
        emit({ type: "complete", project: saved });
      } catch (error) {
        const message = error instanceof Error ? error.message : "生成失败，请重试";
        if (generationAbort.signal.aborted) {
          await releaseGeneration(projectId, identity.ownerId, activeGenerationId, activeProject.versions.length > 0 ? "ready" : "draft", "用户中止生成连接", "cancelled").catch(() => undefined);
        } else {
          let audit: AgentAudit | undefined;
          try {
            const failed = await recordGenerationEvent(activeGenerationId, projectId, { sequence: ++sequence, agent: "Ray", phase: "failure", title: "生成失败", detail: message.slice(0, 600), state: "error" });
            audit = auditFrom(failed);
          } catch { /* preserve the original failure */ }
          emit({ type: "error", message, ...(audit ? { audit } : {}) });
          await markError(projectId, identity.ownerId, activeGenerationId, message, metrics()).catch(() => undefined);
        }
      } finally {
        if (!generationAbort.signal.aborted) controller.close();
      }
    },
    cancel() {
      generationAbort.abort();
    },
  });
  return withWorkspaceIdentity(new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } }), identity);
}
