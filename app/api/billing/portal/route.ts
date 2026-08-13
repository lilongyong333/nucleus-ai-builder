import { BillingError, createBillingPortalSession } from "@/lib/billing";
import { getProject } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { getProjectOrganization, OrganizationError, requireProjectOrganizationRole } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function POST(request: Request) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const body = await request.json() as { projectId?: string };
    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    if (!projectId || !await getProject(projectId, identity.ownerId)) return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    await requireProjectOrganizationRole(projectId, identity.ownerId, ["owner", "admin"]);
    const organization = await getProjectOrganization(projectId, identity.ownerId);
    if (!organization) throw new OrganizationError("项目组织不存在", 404);
    return withWorkspaceIdentity(Response.json(await createBillingPortalSession(organization.id, new URL(request.url).origin)), identity);
  } catch (error) {
    const status = error instanceof BillingError || error instanceof OrganizationError ? error.status : 500;
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "打开 Stripe 账单门户失败" }, { status }), visitor);
  }
}
