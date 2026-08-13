import { getProject } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id } = await context.params;
    const project = await getProject(id, identity.ownerId);
    if (!project) return withWorkspaceIdentity(Response.json({ error: "项目不存在" }, { status: 404 }), identity);
    return withWorkspaceIdentity(Response.json({ project }), identity);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "读取项目失败" }, { status: 500 }), visitor);
  }
}
