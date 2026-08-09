import { beginGeneration, consumeGenerationQuota, getProject, markError, releaseGeneration, saveGeneration } from "@/lib/db";
import { activeModel, buildApp, createPlan } from "@/lib/opencode";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";
import type { AgentEvent, Project } from "@/lib/types";

export const maxDuration = 300;

export async function POST(request: Request) {
  const session = resolveVisitorSession(request);
  let body: { projectId?: string; prompt?: string };
  try { body = await request.json(); } catch { return withVisitorSession(Response.json({ error: "请求格式错误" }, { status: 400 }), session); }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!projectId || prompt.length < 3) return withVisitorSession(Response.json({ error: "项目和需求不能为空" }, { status: 400 }), session);

  let project: Project | null = null;
  let generationId = "";
  try {
    project = await getProject(projectId, session.id);
    if (!project) return withVisitorSession(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), session);
    const lease = await beginGeneration(projectId, session.id, prompt);
    if (!lease) return withVisitorSession(Response.json({ error: "这个项目正在生成，请等待当前任务完成" }, { status: 409 }), session);
    generationId = lease;
    const clientIdentifier = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? session.id;
    if (!(await consumeGenerationQuota(clientIdentifier))) {
      await releaseGeneration(projectId, session.id, generationId, project.versions.length > 0 ? "ready" : "draft");
      return withVisitorSession(Response.json({ error: "本小时生成次数已达上限，请稍后再试" }, { status: 429, headers: { "Retry-After": "3600" } }), session);
    }
  } catch (error) {
    if (generationId) await releaseGeneration(projectId, session.id, generationId, project?.versions.length ? "ready" : "draft").catch(() => undefined);
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "生成准备失败" }, { status: 500 }), session);
  }
  if (!project || !generationId) return withVisitorSession(Response.json({ error: "生成准备失败" }, { status: 500 }), session);
  const activeProject = project;
  const activeGenerationId = generationId;
  const generationAbort = new AbortController();
  request.signal.addEventListener("abort", () => generationAbort.abort(), { once: true });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: AgentEvent) => {
        if (!generationAbort.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        emit({ type: "status", agent: "Iris", title: "理解需求", detail: "正在梳理用户目标和使用场景", state: "working" });
        const hasGeneratedVersion = activeProject.versions.length > 0;
        const plan = await createPlan(prompt, hasGeneratedVersion ? activeProject.files : undefined, generationAbort.signal);
        emit({ type: "plan", plan });
        emit({ type: "status", agent: "Iris", title: "需求分析完成", detail: `${plan.features.length} 个可验证功能`, state: "done" });
        emit({ type: "status", agent: "Bob", title: "设计实现方案", detail: plan.design, state: "working" });
        emit({ type: "status", agent: "Bob", title: "架构确认", detail: "HTML / CSS / JavaScript 三文件应用", state: "done" });
        emit({ type: "status", agent: "Alex", title: "生成应用", detail: "正在实现页面、样式和交互", state: "working" });

        const result = await buildApp(prompt, plan, hasGeneratedVersion ? activeProject.files : undefined, generationAbort.signal);
        for (const path of ["index.html", "styles.css", "script.js"] as const) {
          emit({ type: "file", path, size: result.files[path].length });
        }
        emit({ type: "status", agent: "Alex", title: "代码完成", detail: "3 个文件已写入版本快照", state: "done" });
        emit({ type: "status", agent: "Ray", title: "交付检查", detail: "校验文件完整性与预览安全边界", state: "working" });
        emit({ type: "review", report: result.quality });

        const saved = await saveGeneration(projectId, session.id, activeGenerationId, plan, result.files, result.summary, activeModel(), result.quality);
        emit({ type: "status", agent: "Ray", title: `质量门 ${result.quality.grade} 级`, detail: `${result.quality.score}/100 · 生成物已保存，可回滚、分享和下载`, state: "done" });
        emit({ type: "complete", project: saved });
      } catch (error) {
        if (generationAbort.signal.aborted) {
          await releaseGeneration(projectId, session.id, activeGenerationId, activeProject.versions.length > 0 ? "ready" : "draft").catch(() => undefined);
        } else {
          await markError(projectId, session.id, activeGenerationId).catch(() => undefined);
          emit({ type: "error", message: error instanceof Error ? error.message : "生成失败，请重试" });
        }
      } finally {
        if (!generationAbort.signal.aborted) controller.close();
      }
    },
    cancel() {
      generationAbort.abort();
    },
  });
  return withVisitorSession(new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } }), session);
}
