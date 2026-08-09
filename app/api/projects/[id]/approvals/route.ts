import { getProject } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { listProjectApprovals, OrganizationError, requestProjectApproval } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, context, async (id, ownerId) => ({ approvals: await listProjectApprovals(id, ownerId) }));
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, context, async (id, ownerId, project) => {
    if (!project.currentVersionId) throw new OrganizationError("当前没有可审批版本", 409);
    const body = await request.json().catch(() => ({})) as { comment?: string };
    return { approval: await requestProjectApproval(id, project.currentVersionId, ownerId, body.comment) };
  }, 201);
}

async function handle(request: Request, context: { params: Promise<{ id: string }> }, action: (id: string, ownerId: string, project: NonNullable<Awaited<ReturnType<typeof getProject>>>) => Promise<unknown>, successStatus = 200) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id } = await context.params;
    const project = await getProject(id, identity.ownerId);
    if (!project) return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    return withWorkspaceIdentity(Response.json(await action(id, identity.ownerId, project), { status: successStatus }), identity);
  } catch (error) {
    const status = error instanceof OrganizationError ? error.status : 500;
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "审批操作失败" }, { status }), visitor);
  }
}
