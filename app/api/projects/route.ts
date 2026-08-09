import { createProject, listProjects } from "@/lib/db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function GET(request: Request) {
  const session = resolveVisitorSession(request);
  try {
    return withVisitorSession(Response.json({ projects: await listProjects(session.id) }), session);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "读取项目失败" }, { status: 500 }), session);
  }
}

export async function POST(request: Request) {
  const session = resolveVisitorSession(request);
  try {
    const body = await request.json() as { prompt?: string };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt.length < 3) return withVisitorSession(Response.json({ error: "请至少输入 3 个字的需求" }, { status: 400 }), session);
    if (prompt.length > 2000) return withVisitorSession(Response.json({ error: "需求不能超过 2000 字" }, { status: 400 }), session);
    return withVisitorSession(Response.json({ project: await createProject(prompt, session.id) }, { status: 201 }), session);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "创建项目失败" }, { status: 500 }), session);
  }
}
