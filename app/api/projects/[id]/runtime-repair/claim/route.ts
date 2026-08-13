import { claimBrowserRunnerRepair } from "@/lib/app-platform-db";
import { getProject } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { OrganizationError, requireProjectOrganizationRole } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id } = await context.params;
    if (!await getProject(id, identity.ownerId)) return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    await requireProjectOrganizationRole(id, identity.ownerId, ["owner", "admin", "editor"]);
    return withWorkspaceIdentity(Response.json({ evidence: await claimBrowserRunnerRepair(id) }), identity);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "读取 Ray 修复队列失败" }, { status: error instanceof OrganizationError ? error.status : 500 }), visitor);
  }
}
