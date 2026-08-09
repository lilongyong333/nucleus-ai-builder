import { AppPlatformError, restoreAppBackup } from "@/lib/app-platform-db";
import { getProject } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { OrganizationError, requireProjectOrganizationRole } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function POST(request: Request, context: { params: Promise<{ id: string; backupId: string }> }) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id, backupId } = await context.params;
    if (!await getProject(id, identity.ownerId)) return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    await requireProjectOrganizationRole(id, identity.ownerId, ["owner", "admin"]);
    return withWorkspaceIdentity(Response.json({ backup: await restoreAppBackup(id, backupId, identity.ownerId) }), identity);
  } catch (error) {
    const status = error instanceof AppPlatformError || error instanceof OrganizationError ? error.status : 500;
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "恢复数据备份失败" }, { status }), visitor);
  }
}
