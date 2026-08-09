import { cancelGeneration, getProject } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id } = await context.params;
    if (!(await getProject(id, identity.ownerId))) {
      return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    }
    const generationId = await cancelGeneration(id, identity.ownerId);
    return withWorkspaceIdentity(Response.json({ cancelled: Boolean(generationId) }), identity);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "取消生成失败" }, { status: 500 }), visitor);
  }
}
