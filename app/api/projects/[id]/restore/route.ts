import { restoreVersion } from "@/lib/db";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json() as { versionId?: string };
    if (!body.versionId) return Response.json({ error: "缺少版本 ID" }, { status: 400 });
    const project = await restoreVersion(id, body.versionId);
    if (!project) return Response.json({ error: "版本不存在" }, { status: 404 });
    return Response.json({ project });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "恢复版本失败" }, { status: 500 });
  }
}
