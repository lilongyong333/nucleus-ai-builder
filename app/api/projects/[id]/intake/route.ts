import { getProject, saveProjectIntake } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { deterministicProjectIntake, runIntakeAgent } from "@/lib/opencode";
import { projectOrganizationRole } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export const maxDuration = 100;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id } = await context.params;
    const project = await getProject(id, identity.ownerId);
    if (!project) return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    const role = await projectOrganizationRole(id, identity.ownerId);
    if (!role || !["owner", "admin", "editor"].includes(role)) {
      return withWorkspaceIdentity(Response.json({ error: "当前组织角色不能修改项目需求" }, { status: 403 }), identity);
    }
    if (project.intake) return withWorkspaceIdentity(Response.json({ intake: project.intake, project, recovered: project.intake.source === "deterministic-recovery" }), identity);
    if (project.status !== "draft" || project.currentVersionId || project.runs.length > 0) {
      return withWorkspaceIdentity(Response.json({ error: "只有尚未开始生成的草稿可以进行需求澄清" }, { status: 409 }), identity);
    }

    let intake;
    let recovered = false;
    try {
      intake = (await runIntakeAgent(project.prompt, request.signal)).artifact;
    } catch (error) {
      recovered = true;
      intake = deterministicProjectIntake(project.prompt, error instanceof Error ? error.message : "需求模型暂时不可用");
    }
    const updated = await saveProjectIntake(id, identity.ownerId, intake);
    if (!updated) return withWorkspaceIdentity(Response.json({ error: "草稿状态已经变化，请刷新后继续" }, { status: 409 }), identity);
    return withWorkspaceIdentity(Response.json({ intake: updated.intake, project: updated, recovered }), identity);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "需求澄清失败" }, { status: 500 }), visitor);
  }
}
