import { GitHubAppError, githubAppInstallUrl } from "@/lib/github-app";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

export async function GET(request: Request) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    if (!identity.account) return withWorkspaceIdentity(Response.json({ error: "请先登录账号，再安装 GitHub App" }, { status: 401 }), identity);
    return withWorkspaceIdentity(Response.redirect(githubAppInstallUrl(), 302), identity);
  } catch (error) {
    const status = error instanceof GitHubAppError ? error.status : 500;
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "GitHub App 安装入口不可用" }, { status }), visitor);
  }
}
