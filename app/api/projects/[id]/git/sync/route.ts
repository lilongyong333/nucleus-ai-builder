import { GitAutomationError, syncAgentBranches } from "@/lib/github-automation";
import { getProject } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { OrganizationError, requireProjectOrganizationRole } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id } = await context.params;
    const project = await getProject(id, identity.ownerId);
    if (!project) return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    await requireProjectOrganizationRole(id, identity.ownerId, ["owner", "admin", "editor"]);
    const body = await request.json().catch(() => ({})) as { runId?: string };
    const runId = typeof body.runId === "string" ? body.runId : project.runs.find((run) => run.status === "completed")?.id;
    if (!runId) return withWorkspaceIdentity(Response.json({ error: "没有可同步的完整 Run" }, { status: 409 }), identity);
    return withWorkspaceIdentity(Response.json({ result: await syncAgentBranches(id, runId) }), identity);
  } catch (error) {
    const status = error instanceof GitAutomationError || error instanceof OrganizationError ? error.status : 500;
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "GitHub Agent 分支同步失败" }, { status }), visitor);
  }
}
