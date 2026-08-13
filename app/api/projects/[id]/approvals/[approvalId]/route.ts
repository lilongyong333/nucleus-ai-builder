import { getProject } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { decideProjectApproval, OrganizationError } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function PATCH(request: Request, context: { params: Promise<{ id: string; approvalId: string }> }) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id, approvalId } = await context.params;
    if (!await getProject(id, identity.ownerId)) return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    const body = await request.json() as { decision?: "approved" | "rejected"; comment?: string };
    if (body.decision !== "approved" && body.decision !== "rejected") return withWorkspaceIdentity(Response.json({ error: "审批决定无效" }, { status: 400 }), identity);
    return withWorkspaceIdentity(Response.json({ approval: await decideProjectApproval(id, approvalId, identity.ownerId, body.decision, body.comment) }), identity);
  } catch (error) {
    const status = error instanceof OrganizationError ? error.status : 500;
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "处理审批失败" }, { status }), visitor);
  }
}
