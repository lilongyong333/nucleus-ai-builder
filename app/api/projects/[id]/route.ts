import { getProject } from "@/lib/db";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const project = await getProject(id);
    if (!project) return Response.json({ error: "项目不存在" }, { status: 404 });
    return Response.json({ project });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取项目失败" }, { status: 500 });
  }
}
