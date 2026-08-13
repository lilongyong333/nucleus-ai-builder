import { env } from "cloudflare:workers";
import { beginGeneration, consumeGenerationQuota, getProject, releaseGeneration } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { activeModel } from "@/lib/opencode";
import { organizationHasTokenBudget, projectOrganizationRole } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export const maxDuration = 15;

function hourlyGenerationLimit(): number {
  const raw = (env as unknown as Record<string, unknown>).NUCLEUS_GENERATIONS_PER_HOUR ?? process.env.NUCLEUS_GENERATIONS_PER_HOUR;
  const parsed = Number(raw ?? 100);
  return Math.max(1, Math.min(500, Number.isFinite(parsed) ? Math.floor(parsed) : 100));
}

export async function POST(request: Request) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const body = await request.json() as { projectId?: string; prompt?: string; mode?: "standard" | "race" };
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!projectId || prompt.length < 3) return withWorkspaceIdentity(Response.json({ error: "项目和需求不能为空" }, { status: 400 }), identity);
    if (prompt.length > 8_000) return withWorkspaceIdentity(Response.json({ error: "单轮需求不能超过 8000 字" }, { status: 400 }), identity);
    const project = await getProject(projectId, identity.ownerId);
    if (!project) return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    const role = await projectOrganizationRole(projectId, identity.ownerId);
    if (!role || !["owner", "admin", "editor"].includes(role)) return withWorkspaceIdentity(Response.json({ error: "当前组织角色只有查看或审批权限，不能启动生成" }, { status: 403 }), identity);
    if (!await organizationHasTokenBudget(projectId)) return withWorkspaceIdentity(Response.json({ error: "组织本月 Token 配额已用完，请由管理员调整用量上限" }, { status: 429 }), identity);
    const mode = body.mode === "race" ? "race" : "standard";
    const runId = await beginGeneration(projectId, identity.ownerId, prompt, activeModel(), mode);
    if (!runId) return withWorkspaceIdentity(Response.json({ error: "这个项目已有任务在执行，请等待或继续当前 Run" }, { status: 409 }), identity);
    const clientIdentifier = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? identity.ownerId;
    if (!(await consumeGenerationQuota(clientIdentifier, hourlyGenerationLimit()))) {
      await releaseGeneration(projectId, identity.ownerId, runId, project.versions.length > 0 ? "ready" : "draft", "本小时生成配额已用完");
      return withWorkspaceIdentity(Response.json({ error: "本小时生成次数已达上限，请稍后再试" }, { status: 429, headers: { "Retry-After": "3600" } }), identity);
    }
    const updated = await getProject(projectId, identity.ownerId);
    return withWorkspaceIdentity(Response.json({ runId, project: updated }, { status: 201 }), identity);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "启动生成任务失败" }, { status: 500 }), visitor);
  }
}
