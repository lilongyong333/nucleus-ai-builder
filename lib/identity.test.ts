import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ adoptVisitorProjects: vi.fn() }));

import { accountOwnerId, readAccountIdentity } from "./identity";

describe("workspace account identity", () => {
  it("uses trusted Sites identity headers", () => {
    const request = new Request("https://example.com/api/session", { headers: {
      "oai-authenticated-user-id": "user-123",
      "oai-authenticated-user-email": "PERSON@EXAMPLE.COM",
      "oai-authenticated-user-full-name": encodeURIComponent("李雷"),
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    } });
    expect(readAccountIdentity(request)).toEqual({ userId: "user-123", email: "person@example.com", displayName: "李雷" });
    expect(accountOwnerId("user-123")).toBe("chatgpt:user-123");
  });

  it("treats incomplete identity headers as anonymous", () => {
    expect(readAccountIdentity(new Request("https://example.com", { headers: { "oai-authenticated-user-id": "user-123" } }))).toBeNull();
  });
});
