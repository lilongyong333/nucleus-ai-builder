import { restoreVersion } from "@/lib/db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = resolveVisitorSession(request);
  try {
    const { id } = await context.params;
    const body = await request.json() as { versionId?: string };
    if (!body.versionId) return withVisitorSession(Response.json({ error: "缺少版本 ID" }, { status: 400 }), session);
    const project = await restoreVersion(id, session.id, body.versionId);
    if (!project) return withVisitorSession(Response.json({ error: "项目忙碌、版本不存在或无权访问" }, { status: 404 }), session);
    return withVisitorSession(Response.json({ project }), session);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "恢复版本失败" }, { status: 500 }), session);
  }
}
