import { cancelGeneration, getProject } from "@/lib/db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = resolveVisitorSession(request);
  try {
    const { id } = await context.params;
    if (!(await getProject(id, session.id))) {
      return withVisitorSession(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), session);
    }
    const generationId = await cancelGeneration(id, session.id);
    return withVisitorSession(Response.json({ cancelled: Boolean(generationId) }), session);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "取消生成失败" }, { status: 500 }), session);
  }
}
