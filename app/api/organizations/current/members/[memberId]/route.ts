import { OrganizationError, updateOrganizationMember } from "@/lib/organization-db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function PATCH(request: Request, context: { params: Promise<{ memberId: string }> }) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { memberId } = await context.params;
    const body = await request.json() as { role?: "admin" | "editor" | "reviewer" | "viewer"; status?: "active" | "suspended" };
    return withWorkspaceIdentity(Response.json({ organization: await updateOrganizationMember(identity.ownerId, memberId, body) }), identity);
  } catch (error) {
    const status = error instanceof OrganizationError ? error.status : 500;
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "更新成员失败" }, { status }), visitor);
  }
}
