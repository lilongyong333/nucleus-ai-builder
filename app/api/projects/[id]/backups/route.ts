import { AppPlatformError, createAppBackup, listAppBackups } from "@/lib/app-platform-db";
import { getProject } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { OrganizationError, requireProjectOrganizationRole } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, context, async (id) => ({ backups: await listAppBackups(id) }));
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, context, async (id, ownerId) => {
    const body = await request.json().catch(() => ({})) as { label?: string };
    return { backup: await createAppBackup(id, ownerId, typeof body.label === "string" ? body.label : "手动备份") };
  }, 201);
}

async function handle(request: Request, context: { params: Promise<{ id: string }> }, action: (id: string, ownerId: string) => Promise<unknown>, successStatus = 200) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id } = await context.params;
    if (!await getProject(id, identity.ownerId)) return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    if (request.method === "POST") await requireProjectOrganizationRole(id, identity.ownerId, ["owner", "admin", "editor"]);
    return withWorkspaceIdentity(Response.json(await action(id, identity.ownerId), { status: successStatus }), identity);
  } catch (error) {
    const status = error instanceof AppPlatformError || error instanceof OrganizationError ? error.status : 500;
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "备份操作失败" }, { status }), visitor);
  }
}
