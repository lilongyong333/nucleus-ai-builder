import { AppPlatformError, issueAppSession } from "@/lib/app-platform-db";
import { getProject } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { projectOrganizationRole } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id } = await context.params;
    const project = await getProject(id, identity.ownerId);
    if (!project) return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    const body = await request.json().catch(() => ({})) as { refreshToken?: string };
    const organizationRole = await projectOrganizationRole(id, identity.ownerId);
    const runtimeRole = organizationRole === "owner" || organizationRole === "admin"
      ? "owner"
      : organizationRole === "editor" || organizationRole === "reviewer" || organizationRole === "viewer"
        ? organizationRole
        : "viewer";
    const session = await issueAppSession({
      projectId: id,
      refreshToken: typeof body.refreshToken === "string" ? body.refreshToken : undefined,
      actor: {
        id: identity.ownerId,
        type: identity.account ? "account" : "visitor",
        role: runtimeRole,
        displayName: identity.account?.displayName ?? null,
      },
    });
    return withWorkspaceIdentity(Response.json({ session }), identity);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "创建预览会话失败" }, { status: error instanceof AppPlatformError ? error.status : 500 }), visitor);
  }
}
