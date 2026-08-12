import { getProject, publishProject } from "@/lib/db";
import { listRuntimeEvidence } from "@/lib/app-platform-db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { projectOrganizationRole, publicationApprovalState } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id } = await context.params;
    const current = await getProject(id, identity.ownerId);
    if (current?.currentVersionId) {
      const runtimeChecks = (await listRuntimeEvidence(id, 100)).filter((entry) => entry.versionId === current.currentVersionId && (entry.level === "error" || entry.message === "应用启动完成"));
      const latestRuntimeCheck = runtimeChecks[0];
      if (!latestRuntimeCheck || latestRuntimeCheck.level === "error" || latestRuntimeCheck.evidence.ready !== true) {
        return withWorkspaceIdentity(Response.json({ error: "当前版本尚未通过真实预览启动校验，已拒绝发布" }, { status: 409 }), identity);
      }
    }
    if (!current?.currentVersionId) return withWorkspaceIdentity(Response.json({ error: "项目不存在或没有可发布版本" }, { status: 404 }), identity);
    const role = await projectOrganizationRole(id, identity.ownerId);
    if (!role || !["owner", "admin", "editor"].includes(role)) return withWorkspaceIdentity(Response.json({ error: "当前组织角色不能发布应用" }, { status: 403 }), identity);
    const approval = await publicationApprovalState(id, current.currentVersionId);
    if (!approval.approved) return withWorkspaceIdentity(Response.json({ error: approval.approval?.status === "pending" ? "当前版本正在等待组织审批" : "组织已开启发布审批，请先发起并通过审批", approval }, { status: 409 }), identity);
    const project = await publishProject(id, identity.ownerId);
    if (!project) return withWorkspaceIdentity(Response.json({ error: "项目不存在、正在生成或尚无可发布版本" }, { status: 404 }), identity);
    return withWorkspaceIdentity(Response.json({ project }), identity);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "发布失败" }, { status: 500 }), visitor);
  }
}
