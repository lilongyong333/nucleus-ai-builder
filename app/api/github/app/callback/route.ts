import { completeGitHubInstallationVerification, GitHubAppError } from "@/lib/github-app";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";

const OAUTH_COOKIE = "nucleus_github_oauth_state";

export async function GET(request: Request) {
  const visitor = resolveVisitorSession(request);
  try {
    const url = new URL(request.url);
    const result = await completeGitHubInstallationVerification({
      code: url.searchParams.get("code") ?? "",
      state: url.searchParams.get("state") ?? "",
      cookieState: readCookie(request.headers.get("cookie"), OAUTH_COOKIE),
    });
    const destination = new URL(result.returnTo, url.origin);
    destination.searchParams.set("github", "connected");
    destination.searchParams.set("installation", result.installation.installationId);
    const response = Response.redirect(destination, 302);
    response.headers.append("Set-Cookie", `${OAUTH_COOKIE}=; Path=/api/github/app; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
    return withVisitorSession(response, visitor);
  } catch (error) {
    const status = error instanceof GitHubAppError ? error.status : 500;
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "GitHub App OAuth 回调失败" }, { status }), visitor);
  }
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return null; }
  }
  return null;
}
