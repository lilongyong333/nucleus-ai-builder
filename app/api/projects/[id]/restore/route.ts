import { restoreVersion } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { projectOrganizationRole } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id } = await context.params;
    const role = await projectOrganizationRole(id, identity.ownerId);
    if (!role || !["owner", "admin", "editor"].includes(role)) return withWorkspaceIdentity(Response.json({ error: "当前组织角色不能恢复版本" }, { status: role ? 403 : 404 }), identity);
    const body = await request.json() as { versionId?: string };
    if (!body.versionId) return withWorkspaceIdentity(Response.json({ error: "缺少版本 ID" }, { status: 400 }), identity);
    const project = await restoreVersion(id, identity.ownerId, body.versionId);
    if (!project) return withWorkspaceIdentity(Response.json({ error: "项目忙碌、版本不存在或无权访问" }, { status: 404 }), identity);
    return withWorkspaceIdentity(Response.json({ project }), identity);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "恢复版本失败" }, { status: 500 }), visitor);
  }
}
