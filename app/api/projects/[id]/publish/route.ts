import { publishProject } from "@/lib/db";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const project = await publishProject(id);
    if (!project) return Response.json({ error: "项目不存在" }, { status: 404 });
    return Response.json({ project });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "发布失败" }, { status: 500 });
  }
}
