import { env } from "cloudflare:workers";
import { ensureSchema } from "./db";
import type { GitHubAppInstallation } from "./types";

type D1Row = Record<string, string | number | null>;
type GitHubInstallationPayload = {
  id: number;
  account?: { login?: string; type?: string };
  permissions?: Record<string, string>;
  repository_selection?: string;
  suspended_at?: string | null;
};

export class GitHubAppError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "GitHubAppError";
  }
}

type GitHubAppConfig = {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
};

function database(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new GitHubAppError("GitHub App 控制面数据库暂不可用", 503);
  return binding;
}

function configuration(): GitHubAppConfig | null {
  const runtime = env as unknown as Record<string, unknown>;
  const appId = stringEnv(runtime.GITHUB_APP_ID);
  const slug = stringEnv(runtime.GITHUB_APP_SLUG);
  const clientId = stringEnv(runtime.GITHUB_APP_CLIENT_ID);
  const clientSecret = stringEnv(runtime.GITHUB_APP_CLIENT_SECRET);
  const privateKey = stringEnv(runtime.GITHUB_APP_PRIVATE_KEY)?.replaceAll("\\n", "\n") ?? null;
  return appId && slug && clientId && clientSecret && privateKey ? { appId, slug, clientId, clientSecret, privateKey } : null;
}

export function githubAppConfigured(): boolean {
  return configuration() !== null;
}

export function githubAppInstallUrl(): string {
  const config = requireConfiguration();
  return `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new`;
}

export async function beginGitHubInstallationVerification(input: { ownerId: string; installationId: string; origin: string; returnTo?: string }): Promise<{ authorizationUrl: string; state: string }> {
  await ensureSchema();
  const config = requireConfiguration();
  if (!/^\d{1,24}$/.test(input.installationId)) throw new GitHubAppError("GitHub installation_id 格式无效");
  const state = randomToken();
  const stateHash = await sha256(state);
  const now = new Date();
  const returnTo = safeReturnTo(input.returnTo);
  const redirectUri = `${normalizeOrigin(input.origin)}/api/github/app/callback`;
  await database().prepare(`DELETE FROM oauth_states WHERE expires_at<? OR consumed_at IS NOT NULL`).bind(now.toISOString()).run();
  await database().prepare(`INSERT INTO oauth_states (id,owner_id,provider,state_hash,payload_json,expires_at,consumed_at,created_at) VALUES (?,?,'github-app',?,?,?,NULL,?)`).bind(
    crypto.randomUUID(), input.ownerId, stateHash, JSON.stringify({ installationId: input.installationId, redirectUri, returnTo }), new Date(now.getTime() + 10 * 60_000).toISOString(), now.toISOString(),
  ).run();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  return { authorizationUrl: url.toString(), state };
}

export async function completeGitHubInstallationVerification(input: { code: string; state: string; cookieState: string | null }): Promise<{ installation: GitHubAppInstallation; returnTo: string }> {
  await ensureSchema();
  const config = requireConfiguration();
  if (!input.code || input.code.length > 300 || !input.state || input.state.length > 300 || input.cookieState !== input.state) throw new GitHubAppError("GitHub OAuth state 校验失败，请重新安装", 403);
  const stateHash = await sha256(input.state);
  const now = new Date().toISOString();
  const stateRow = await database().prepare(`UPDATE oauth_states SET consumed_at=? WHERE provider='github-app' AND state_hash=? AND consumed_at IS NULL AND expires_at>? RETURNING *`).bind(now, stateHash, now).first<D1Row>();
  if (!stateRow) throw new GitHubAppError("GitHub OAuth state 已过期或已使用，请重新安装", 403);
  const payload = parseJson<{ installationId?: string; redirectUri?: string; returnTo?: string }>(stateRow.payload_json, {});
  if (!payload.installationId || !payload.redirectUri) throw new GitHubAppError("GitHub App 安装上下文已损坏", 409);

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Nucleus-AI-Builder" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code: input.code, redirect_uri: payload.redirectUri }),
  });
  const tokenData = await tokenResponse.json().catch(() => ({})) as { access_token?: string; error_description?: string; error?: string };
  if (!tokenResponse.ok || !tokenData.access_token) throw new GitHubAppError(tokenData.error_description || tokenData.error || "GitHub OAuth token 交换失败", 502);

  const installations = await githubUserRequest<{ installations?: GitHubInstallationPayload[] }>(tokenData.access_token, "/user/installations?per_page=100");
  const verified = installations.installations?.find((item) => String(item.id) === payload.installationId);
  if (!verified) throw new GitHubAppError("该 installation_id 不属于当前 GitHub 用户，已拒绝绑定", 403);
  const installation = await saveInstallation(String(stateRow.owner_id), verified);
  return { installation, returnTo: safeReturnTo(payload.returnTo) };
}

export async function listGitHubAppInstallations(ownerId: string): Promise<GitHubAppInstallation[]> {
  await ensureSchema();
  const result = await database().prepare(`SELECT * FROM github_app_installations WHERE owner_id=? ORDER BY updated_at DESC`).bind(ownerId).all<D1Row>();
  return (result.results ?? []).map(installationFromRow);
}

export async function findInstallationForRepository(ownerId: string, repositoryOwner: string): Promise<GitHubAppInstallation | null> {
  await ensureSchema();
  const row = await database().prepare(`SELECT * FROM github_app_installations WHERE owner_id=? AND lower(account_login)=lower(?) AND status='active' ORDER BY updated_at DESC LIMIT 1`).bind(ownerId, repositoryOwner).first<D1Row>();
  return row ? installationFromRow(row) : null;
}

export async function createInstallationAccessToken(installationId: string): Promise<string> {
  const config = requireConfiguration();
  if (!/^\d{1,24}$/.test(installationId)) throw new GitHubAppError("GitHub App installation_id 无效");
  const jwt = await createAppJwt(config);
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "Nucleus-AI-Builder",
    },
  });
  const data = await response.json().catch(() => ({})) as { token?: string; message?: string };
  if (!response.ok || !data.token) throw new GitHubAppError(data.message || `GitHub installation token 返回 ${response.status}`, response.status === 401 || response.status === 403 ? 503 : 502);
  return data.token;
}

async function saveInstallation(ownerId: string, payload: GitHubInstallationPayload): Promise<GitHubAppInstallation> {
  const now = new Date().toISOString();
  const status = payload.suspended_at ? "suspended" : "active";
  await database().prepare(`INSERT INTO github_app_installations (installation_id,owner_id,account_login,account_type,permissions_json,repository_selection,status,suspended_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(installation_id) DO UPDATE SET owner_id=excluded.owner_id,account_login=excluded.account_login,account_type=excluded.account_type,permissions_json=excluded.permissions_json,repository_selection=excluded.repository_selection,status=excluded.status,suspended_at=excluded.suspended_at,updated_at=excluded.updated_at`).bind(
    String(payload.id), ownerId, payload.account?.login ?? null, payload.account?.type ?? null, JSON.stringify(payload.permissions ?? {}), payload.repository_selection ?? null, status, payload.suspended_at ?? null, now, now,
  ).run();
  const row = await database().prepare(`SELECT * FROM github_app_installations WHERE installation_id=?`).bind(String(payload.id)).first<D1Row>();
  if (!row) throw new GitHubAppError("GitHub App 安装记录保存失败", 500);
  return installationFromRow(row);
}

async function githubUserRequest<T>(accessToken: string, path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "Nucleus-AI-Builder",
    },
  });
  const data = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new GitHubAppError(data.message || `GitHub API 返回 ${response.status}`, response.status);
  return data;
}

async function createAppJwt(config: GitHubAppConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: config.appId })));
  const signingInput = `${header}.${payload}`;
  const key = await importPrivateKey(config.privateKey);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.trim();
  const isPkcs1 = normalized.includes("BEGIN RSA PRIVATE KEY");
  const body = normalized.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----|\s+/g, "");
  if (!body) throw new GitHubAppError("GITHUB_APP_PRIVATE_KEY 格式无效", 503);
  let der = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
  if (isPkcs1) der = new Uint8Array(wrapPkcs1AsPkcs8(der));
  try {
    return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new GitHubAppError("GITHUB_APP_PRIVATE_KEY 无法导入，请使用 GitHub 下载的 RSA 私钥", 503);
  }
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  const privateKey = concatBytes(Uint8Array.of(0x04), derLength(pkcs1.length), pkcs1);
  const content = concatBytes(version, rsaAlgorithm, privateKey);
  return concatBytes(Uint8Array.of(0x30), derLength(content.length), content);
}

function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

function installationFromRow(row: D1Row): GitHubAppInstallation {
  return {
    installationId: String(row.installation_id),
    accountLogin: row.account_login ? String(row.account_login) : null,
    accountType: row.account_type ? String(row.account_type) : null,
    repositorySelection: row.repository_selection ? String(row.repository_selection) : null,
    status: String(row.status) as GitHubAppInstallation["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function safeReturnTo(value: unknown): string {
  return typeof value === "string" && /^\/[a-zA-Z0-9_?&=./%-]{0,500}$/.test(value) && !value.startsWith("//") ? value : "/account";
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new GitHubAppError("GitHub OAuth 回调必须使用 HTTPS", 400);
  return url.origin;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

async function sha256(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function stringEnv(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireConfiguration(): GitHubAppConfig {
  const config = configuration();
  if (!config) throw new GitHubAppError("GitHub App 尚未配置完整的 App ID、Slug、OAuth Client 和私钥", 503);
  return config;
}
