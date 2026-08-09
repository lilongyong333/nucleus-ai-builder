import { getProject } from "@/lib/db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = resolveVisitorSession(request);
  try {
    const { id } = await context.params;
    const project = await getProject(id, session.id);
    if (!project) return withVisitorSession(Response.json({ error: "项目不存在" }, { status: 404 }), session);
    return withVisitorSession(Response.json({ project }), session);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "读取项目失败" }, { status: 500 }), session);
  }
}
