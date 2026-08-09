const SESSION_COOKIE = "nucleus_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const SESSION_ID_PATTERN = /^[a-f0-9]{32}$/;

export type VisitorSession = {
  id: string;
  cookie: string | null;
};

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function resolveVisitorSession(request: Request): VisitorSession {
  const existing = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (existing && SESSION_ID_PATTERN.test(existing)) return { id: existing, cookie: null };

  const id = crypto.randomUUID().replaceAll("-", "");
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return {
    id,
    cookie: `${SESSION_COOKIE}=${id}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure}`,
  };
}

export function withVisitorSession(response: Response, session: VisitorSession): Response {
  response.headers.set("Cache-Control", "private, no-store");
  if (session.cookie) response.headers.append("Set-Cookie", session.cookie);
  return response;
}
