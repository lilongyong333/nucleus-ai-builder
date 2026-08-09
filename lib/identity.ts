import { adoptVisitorProjects } from "./db";
import { resolveVisitorSession, withVisitorSession, type VisitorSession } from "./session";

export type AccountIdentity = {
  userId: string;
  email: string;
  displayName: string;
};

export type WorkspaceIdentity = {
  ownerId: string;
  visitor: VisitorSession;
  account: AccountIdentity | null;
};

export function readAccountIdentity(request: Request): AccountIdentity | null {
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (!userId || !email) return null;
  const encodedName = request.headers.get("oai-authenticated-user-full-name");
  const displayName = encodedName && request.headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8"
    ? safeDecode(encodedName) ?? email
    : email;
  return { userId, email, displayName };
}

export function accountOwnerId(userId: string): string {
  return `chatgpt:${userId}`;
}

export async function resolveWorkspaceIdentity(request: Request, visitor = resolveVisitorSession(request)): Promise<WorkspaceIdentity> {
  const account = readAccountIdentity(request);
  const ownerId = account ? accountOwnerId(account.userId) : visitor.id;
  if (account && visitor.id !== ownerId) await adoptVisitorProjects(visitor.id, ownerId);
  return { ownerId, visitor, account };
}

export function withWorkspaceIdentity(response: Response, identity: WorkspaceIdentity): Response {
  return withVisitorSession(response, identity.visitor);
}

function safeDecode(value: string): string | null {
  try { return decodeURIComponent(value); } catch { return null; }
}
