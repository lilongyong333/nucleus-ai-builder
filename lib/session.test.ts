import { describe, expect, it, vi } from "vitest";
import { resolveVisitorSession, withVisitorSession } from "./session";

describe("anonymous visitor session", () => {
  it("reuses a valid owner cookie", () => {
    const id = "a".repeat(32);
    const session = resolveVisitorSession(new Request("https://example.com/api/projects", {
      headers: { cookie: `theme=dark; nucleus_session=${id}` },
    }));
    expect(session).toEqual({ id, cookie: null });
  });

  it("replaces malformed cookies with an opaque id", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "12345678-1234-1234-1234-123456789abc" });
    const session = resolveVisitorSession(new Request("https://example.com/api/projects", {
      headers: { cookie: "nucleus_session=not-valid" },
    }));
    expect(session.id).toBe("12345678123412341234123456789abc");
    expect(session.cookie).toContain("HttpOnly");
    expect(session.cookie).toContain("SameSite=Lax");
    expect(session.cookie).toContain("Secure");
    vi.unstubAllGlobals();
  });

  it("attaches the cookie only when a session is new", () => {
    const response = withVisitorSession(Response.json({ ok: true }), {
      id: "b".repeat(32),
      cookie: "nucleus_session=value; Path=/",
    });
    expect(response.headers.get("set-cookie")).toContain("nucleus_session=value");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
