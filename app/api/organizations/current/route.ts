import { getCurrentOrganization, OrganizationError, updateOrganizationSettings } from "@/lib/organization-db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function GET(request: Request) {
  return handle(request, async (ownerId) => ({ organization: await getCurrentOrganization(ownerId) }));
}

export async function PATCH(request: Request) {
  return handle(request, async (ownerId) => {
    const body = await request.json() as { name?: string; monthlyTokenLimit?: number; approvalRequired?: boolean; projectId?: string };
    return { organization: await updateOrganizationSettings(ownerId, body, typeof body.projectId === "string" ? body.projectId : undefined) };
  });
}

async function handle(request: Request, action: (ownerId: string) => Promise<unknown>) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    return withWorkspaceIdentity(Response.json(await action(identity.ownerId)), identity);
  } catch (error) {
    const status = error instanceof OrganizationError ? error.status : 500;
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "组织操作失败" }, { status }), visitor);
  }
}
