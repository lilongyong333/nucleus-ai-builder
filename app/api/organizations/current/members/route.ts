import { inviteOrganizationMember, OrganizationError } from "@/lib/organization-db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";
import { NotificationError, sendOrganizationInviteEmail } from "@/lib/notifications";

export async function POST(request: Request) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const body = await request.json() as { email?: string; role?: "admin" | "editor" | "reviewer" | "viewer"; projectId?: string };
    const email = typeof body.email === "string" ? body.email : "";
    const role = body.role === "admin" || body.role === "reviewer" || body.role === "viewer" ? body.role : "editor";
    const projectId = typeof body.projectId === "string" ? body.projectId : undefined;
    const organization = await inviteOrganizationMember(identity.ownerId, email, role, projectId);
    const delivery = await sendOrganizationInviteEmail({
      organizationId: organization.id,
      projectId,
      organizationName: organization.name,
      recipient: email,
      inviterName: identity.account?.displayName ?? "Nucleus 协作者",
      role,
      origin: new URL(request.url).origin,
    });
    return withWorkspaceIdentity(Response.json({ organization, delivery }, { status: 201 }), identity);
  } catch (error) {
    const status = error instanceof OrganizationError || error instanceof NotificationError ? error.status : 500;
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "邀请成员失败" }, { status }), visitor);
  }
}
