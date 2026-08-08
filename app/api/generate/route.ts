import { consumeGenerationQuota, getProject, markError, markGenerating, saveGeneration } from "@/lib/db";
import { activeModel, buildApp, createPlan } from "@/lib/opencode";
import type { AgentEvent } from "@/lib/types";

export const maxDuration = 300;

export async function POST(request: Request) {
  let body: { projectId?: string; prompt?: string };
  try { body = await request.json(); } catch { return Response.json({ error: "请求格式错误" }, { status: 400 }); }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!projectId || prompt.length < 3) return Response.json({ error: "项目和需求不能为空" }, { status: 400 });
  const clientIdentifier = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? `unknown:${request.headers.get("user-agent") ?? "browser"}`;
  if (!(await consumeGenerationQuota(clientIdentifier))) {
    return Response.json({ error: "本小时生成次数已达上限，请稍后再试" }, { status: 429, headers: { "Retry-After": "3600" } });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: AgentEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const project = await getProject(projectId);
        if (!project) throw new Error("项目不存在或已被删除");
        await markGenerating(projectId, prompt);

        emit({ type: "status", agent: "Iris", title: "理解需求", detail: "正在梳理用户目标和使用场景", state: "working" });
        const hasGeneratedVersion = project.versions.length > 0;
        const plan = await createPlan(prompt, hasGeneratedVersion ? project.files : undefined);
        emit({ type: "plan", plan });
        emit({ type: "status", agent: "Iris", title: "需求分析完成", detail: `${plan.features.length} 个可验证功能`, state: "done" });
        emit({ type: "status", agent: "Bob", title: "设计实现方案", detail: plan.design, state: "working" });
        emit({ type: "status", agent: "Bob", title: "架构确认", detail: "HTML / CSS / JavaScript 三文件应用", state: "done" });
        emit({ type: "status", agent: "Alex", title: "生成应用", detail: "正在实现页面、样式和交互", state: "working" });

        const result = await buildApp(prompt, plan, hasGeneratedVersion ? project.files : undefined);
        for (const path of ["index.html", "styles.css", "script.js"] as const) {
          emit({ type: "file", path, size: result.files[path].length });
        }
        emit({ type: "status", agent: "Alex", title: "代码完成", detail: "3 个文件已写入版本快照", state: "done" });
        emit({ type: "status", agent: "Ray", title: "交付检查", detail: "校验文件完整性与预览安全边界", state: "working" });

        const saved = await saveGeneration(projectId, plan, result.files, result.summary, activeModel());
        emit({ type: "status", agent: "Ray", title: "可以预览", detail: "生成物已保存，可回滚、分享和下载", state: "done" });
        emit({ type: "complete", project: saved });
      } catch (error) {
        await markError(projectId).catch(() => undefined);
        emit({ type: "error", message: error instanceof Error ? error.message : "生成失败，请重试" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" } });
}
