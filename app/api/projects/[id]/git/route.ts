import { configureGitIntegration, getGitIntegration, GitAutomationError } from "@/lib/github-automation";
import { getProject } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { OrganizationError, requireProjectOrganizationRole } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, context, async (id) => ({ integration: await getGitIntegration(id) }));
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, context, async (id, ownerId) => {
    const body = await request.json() as { repositoryOwner?: string; repositoryName?: string; defaultBranch?: string };
    if (typeof body.repositoryOwner !== "string" || typeof body.repositoryName !== "string") throw new GitAutomationError("仓库所有者和仓库名称不能为空");
    return { integration: await configureGitIntegration(id, ownerId, { repositoryOwner: body.repositoryOwner, repositoryName: body.repositoryName, defaultBranch: body.defaultBranch }) };
  });
}

async function handle(request: Request, context: { params: Promise<{ id: string }> }, action: (id: string, ownerId: string) => Promise<unknown>) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id } = await context.params;
    if (!await getProject(id, identity.ownerId)) return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    if (request.method === "PUT") await requireProjectOrganizationRole(id, identity.ownerId, ["owner", "admin"]);
    return withWorkspaceIdentity(Response.json(await action(id, identity.ownerId)), identity);
  } catch (error) {
    const status = error instanceof GitAutomationError || error instanceof OrganizationError ? error.status : 500;
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "GitHub 集成失败" }, { status }), visitor);
  }
}
