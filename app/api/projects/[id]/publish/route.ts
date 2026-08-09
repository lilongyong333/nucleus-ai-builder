import { publishProject } from "@/lib/db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = resolveVisitorSession(request);
  try {
    const { id } = await context.params;
    const project = await publishProject(id, session.id);
    if (!project) return withVisitorSession(Response.json({ error: "项目不存在、正在生成或尚无可发布版本" }, { status: 404 }), session);
    return withVisitorSession(Response.json({ project }), session);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "发布失败" }, { status: 500 }), session);
  }
}
