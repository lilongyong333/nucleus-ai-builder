import { AppPlatformError, issueAppSession, resolvePublishedApp } from "@/lib/app-platform-db";
import { accountOwnerId, readAccountIdentity } from "@/lib/identity";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  const visitor = resolveVisitorSession(request);
  try {
    const { slug } = await context.params;
    const published = await resolvePublishedApp(slug);
    if (!published) return withVisitorSession(Response.json({ error: "公开应用不存在或尚未发布" }, { status: 404 }), visitor);
    const body = await request.json().catch(() => ({})) as { refreshToken?: string };
    const account = readAccountIdentity(request);
    const session = await issueAppSession({
      projectId: published.projectId,
      refreshToken: typeof body.refreshToken === "string" ? body.refreshToken : undefined,
      actor: account
        ? { id: accountOwnerId(account.userId), type: "account", role: "user", displayName: account.displayName }
        : { id: `visitor:${visitor.id}`, type: "visitor", role: "user", displayName: null },
    });
    return withVisitorSession(Response.json({ session }), visitor);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "创建应用会话失败" }, { status: error instanceof AppPlatformError ? error.status : 500 }), visitor);
  }
}
