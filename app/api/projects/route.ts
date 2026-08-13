import { createProject, listProjects } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function GET(request: Request) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    return withWorkspaceIdentity(Response.json({ projects: await listProjects(identity.ownerId), account: identity.account }), identity);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "读取项目失败" }, { status: 500 }), visitor);
  }
}

export async function POST(request: Request) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const body = await request.json() as { prompt?: string };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt.length < 3) return withWorkspaceIdentity(Response.json({ error: "请至少输入 3 个字的需求" }, { status: 400 }), identity);
    if (prompt.length > 2000) return withWorkspaceIdentity(Response.json({ error: "需求不能超过 2000 字" }, { status: 400 }), identity);
    return withWorkspaceIdentity(Response.json({ project: await createProject(prompt, identity.ownerId) }, { status: 201 }), identity);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "创建项目失败" }, { status: 500 }), visitor);
  }
}
