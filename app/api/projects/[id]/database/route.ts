import {
  cancelProjectDatabaseDeletion,
  DatabaseProvisioningError,
  ensureProjectDatabase,
  getDatabaseResource,
  listProvisioningEvents,
  scheduleProjectDatabaseDeletion,
} from "@/lib/database-provisioner";
import { getProject } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { OrganizationError, requireProjectOrganizationRole } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export const maxDuration = 60;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, context, async (id) => ({ resource: await getDatabaseResource(id), events: await listProvisioningEvents(id) }));
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, context, async (id, ownerId) => {
    await requireProjectOrganizationRole(id, ownerId, ["owner", "admin", "editor"]);
    return { resource: await ensureProjectDatabase(id), events: await listProvisioningEvents(id) };
  });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, context, async (id, ownerId) => {
    await requireProjectOrganizationRole(id, ownerId, ["owner", "admin"]);
    const body = await request.json().catch(() => ({})) as { retentionDays?: number };
    return { resource: await scheduleProjectDatabaseDeletion(id, typeof body.retentionDays === "number" ? body.retentionDays : 30) };
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, context, async (id, ownerId) => {
    await requireProjectOrganizationRole(id, ownerId, ["owner", "admin"]);
    return { resource: await cancelProjectDatabaseDeletion(id) };
  });
}

async function handle(
  request: Request,
  context: { params: Promise<{ id: string }> },
  action: (id: string, ownerId: string) => Promise<unknown>,
) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id } = await context.params;
    if (!await getProject(id, identity.ownerId)) return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    return withWorkspaceIdentity(Response.json(await action(id, identity.ownerId)), identity);
  } catch (error) {
    const status = error instanceof DatabaseProvisioningError || error instanceof OrganizationError ? error.status : 500;
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "数据库 Provisioner 执行失败" }, { status }), visitor);
  }
}
