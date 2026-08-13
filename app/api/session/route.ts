import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function GET(request: Request) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    return withWorkspaceIdentity(Response.json({
      authenticated: Boolean(identity.account),
      account: identity.account ? { email: identity.account.email, displayName: identity.account.displayName } : null,
    }), identity);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "读取账户失败" }, { status: 500 }), visitor);
  }
}
