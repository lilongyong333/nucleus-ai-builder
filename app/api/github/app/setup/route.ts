import { beginGitHubInstallationVerification, GitHubAppError } from "@/lib/github-app";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

const OAUTH_COOKIE = "nucleus_github_oauth_state";

export async function GET(request: Request) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    if (!identity.account) return withWorkspaceIdentity(Response.json({ error: "请先登录账号，再验证 GitHub App 安装" }, { status: 401 }), identity);
    const url = new URL(request.url);
    const installationId = url.searchParams.get("installation_id") ?? "";
    const result = await beginGitHubInstallationVerification({ ownerId: identity.ownerId, installationId, origin: url.origin, returnTo: url.searchParams.get("return_to") ?? "/account?github=connected" });
    const response = Response.redirect(result.authorizationUrl, 302);
    response.headers.append("Set-Cookie", `${OAUTH_COOKIE}=${encodeURIComponent(result.state)}; Path=/api/github/app; Max-Age=600; HttpOnly; SameSite=Lax; Secure`);
    return withWorkspaceIdentity(response, identity);
  } catch (error) {
    const status = error instanceof GitHubAppError ? error.status : 500;
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "GitHub App 安装验证启动失败" }, { status }), visitor);
  }
}
