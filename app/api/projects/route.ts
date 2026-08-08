import { createProject, listProjects } from "@/lib/db";

export async function GET() {
  try {
    return Response.json({ projects: await listProjects() });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取项目失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { prompt?: string };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt.length < 3) return Response.json({ error: "请至少输入 3 个字的需求" }, { status: 400 });
    if (prompt.length > 2000) return Response.json({ error: "需求不能超过 2000 字" }, { status: 400 });
    return Response.json({ project: await createProject(prompt) }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "创建项目失败" }, { status: 500 });
  }
}
