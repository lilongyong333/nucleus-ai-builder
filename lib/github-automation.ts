import { env } from "cloudflare:workers";
import { ensureSchema } from "./db";
import { createInstallationAccessToken, findInstallationForRepository, githubAppConfigured } from "./github-app";
import type { AgentName, GitIntegration, GitSyncResult, GenerationArtifactKind } from "./types";

type D1Row = Record<string, string | number | null>;

export class GitAutomationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "GitAutomationError";
  }
}

function database(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new GitAutomationError("Git 控制面数据库暂不可用", 503);
  return binding;
}

function personalAccessToken(): string | null {
  const value = (env as unknown as Record<string, unknown>).GITHUB_AUTOMATION_TOKEN ?? process.env.GITHUB_AUTOMATION_TOKEN;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function getGitIntegration(projectId: string): Promise<GitIntegration | null> {
  await ensureSchema();
  const row = await database().prepare(`SELECT * FROM git_integrations WHERE project_id=?`).bind(projectId).first<D1Row>();
  return row ? integrationFromRow(row) : null;
}

export async function configureGitIntegration(projectId: string, ownerId: string, input: { repositoryOwner: string; repositoryName: string; defaultBranch?: string }): Promise<GitIntegration> {
  await ensureSchema();
  const repositoryOwner = safeSegment(input.repositoryOwner, "仓库所有者");
  const repositoryName = safeSegment(input.repositoryName.replace(/\.git$/i, ""), "仓库名称");
  const defaultBranch = safeBranch(input.defaultBranch ?? "main");
  const now = new Date().toISOString();
  const installation = await findInstallationForRepository(ownerId, repositoryOwner);
  const status = personalAccessToken() || installation ? "connected" : "configuration-required";
  await database().prepare(`INSERT INTO git_integrations (project_id,provider,repository_owner,repository_name,default_branch,installation_id,status,last_sync_json,created_at,updated_at) VALUES (?,'github',?,?,?,?,?,NULL,?,?) ON CONFLICT(project_id) DO UPDATE SET repository_owner=excluded.repository_owner,repository_name=excluded.repository_name,default_branch=excluded.default_branch,installation_id=excluded.installation_id,status=excluded.status,updated_at=excluded.updated_at`).bind(projectId, repositoryOwner, repositoryName, defaultBranch, installation?.installationId ?? null, status, now, now).run();
  return (await getGitIntegration(projectId))!;
}

export async function syncAgentBranches(projectId: string, runId: string): Promise<GitSyncResult> {
  await ensureSchema();
  const integration = await getGitIntegration(projectId);
  if (!integration) throw new GitAutomationError("请先连接 GitHub 仓库", 409);
  const automationToken = personalAccessToken() ?? (integration.installationId ? await createInstallationAccessToken(integration.installationId) : null);
  if (!automationToken) throw new GitAutomationError(githubAppConfigured() ? "请先安装 GitHub App，并将仓库重新连接到对应 Installation" : "GitHub App 尚未配置；兼容模式也没有服务端 PAT", 409);
  const artifactRows = await database().prepare(`SELECT agent,kind,content FROM generation_artifacts WHERE project_id=? AND run_id=? ORDER BY created_at ASC`).bind(projectId, runId).all<D1Row>();
  if (!(artifactRows.results ?? []).length) throw new GitAutomationError("这个 Run 没有可同步工件", 404);
  const artifacts = new Map((artifactRows.results ?? []).map((row) => [String(row.kind) as GenerationArtifactKind, String(row.content)]));
  for (const required of ["requirements", "architecture", "index.html", "styles.css", "script.js", "quality"] as const) {
    if (!artifacts.has(required)) throw new GitAutomationError(`Run 缺少 ${required} 工件，拒绝创建不完整分支`, 409);
  }

  const owner = integration.repositoryOwner;
  const repo = integration.repositoryName;
  const baseRef = await github<{ object: { sha: string } }>(automationToken, owner, repo, `git/ref/${encodeURIComponent(`heads/${integration.defaultBranch}`)}`);
  let parentSha = baseRef.object.sha;
  let treeSha = (await github<{ tree: { sha: string } }>(automationToken, owner, repo, `git/commits/${parentSha}`)).tree.sha;
  const shortRun = runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "run";
  const groups: Array<{ agent: AgentName; files: Record<string, string> }> = [
    { agent: "Iris", files: { "nucleus/requirements.json": prettyJson(artifacts.get("requirements")!) } },
    { agent: "Bob", files: { "nucleus/architecture.json": prettyJson(artifacts.get("architecture")!), "nucleus/app-manifest.json": prettyJson(artifacts.get("manifest") ?? "{}") } },
    { agent: "Alex", files: { "index.html": artifacts.get("index.html")!, "styles.css": artifacts.get("styles.css")!, "script.js": artifacts.get("script.js")! } },
    { agent: "Ray", files: { "nucleus/quality.json": prettyJson(artifacts.get("quality")!) } },
  ];
  const branches: GitSyncResult["branches"] = [];
  let finalBranch = "";
  for (const group of groups) {
    const treeEntries = [];
    for (const [path, content] of Object.entries(group.files)) {
      const blob = await github<{ sha: string }>(automationToken, owner, repo, "git/blobs", { method: "POST", body: { content, encoding: "utf-8" } });
      treeEntries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const tree = await github<{ sha: string }>(automationToken, owner, repo, "git/trees", { method: "POST", body: { base_tree: treeSha, tree: treeEntries } });
    const commit = await github<{ sha: string }>(automationToken, owner, repo, "git/commits", { method: "POST", body: { message: `Nucleus ${group.agent}: ${runId}`, tree: tree.sha, parents: [parentSha] } });
    const branch = `nucleus/${shortRun}/${group.agent.toLowerCase()}`;
    await createOrUpdateReference(automationToken, owner, repo, branch, commit.sha);
    branches.push({ agent: group.agent, branch, commitSha: commit.sha });
    parentSha = commit.sha;
    treeSha = tree.sha;
    finalBranch = branch;
  }

  const merge = await github<{ sha?: string; commit?: { sha?: string } }>(automationToken, owner, repo, "merges", {
    method: "POST",
    body: { base: integration.defaultBranch, head: finalBranch, commit_message: `Merge Nucleus multi-agent run ${runId}` },
    acceptedStatuses: [201, 204],
  });
  const result: GitSyncResult = {
    runId,
    branches,
    mergedCommitSha: merge.sha ?? merge.commit?.sha ?? parentSha,
    repositoryUrl: `https://github.com/${owner}/${repo}`,
    completedAt: new Date().toISOString(),
  };
  await database().prepare(`UPDATE git_integrations SET status='connected',last_sync_json=?,updated_at=? WHERE project_id=?`).bind(JSON.stringify(result), result.completedAt, projectId).run();
  return result;
}

async function createOrUpdateReference(automationToken: string, owner: string, repo: string, branch: string, sha: string): Promise<void> {
  try {
    await github(automationToken, owner, repo, "git/refs", { method: "POST", body: { ref: `refs/heads/${branch}`, sha } });
  } catch (error) {
    if (!(error instanceof GitAutomationError) || error.status !== 422) throw error;
    await github(automationToken, owner, repo, `git/refs/${encodeURIComponent(`heads/${branch}`)}`, { method: "PATCH", body: { sha, force: false } });
  }
}

async function github<T = Record<string, unknown>>(automationToken: string, owner: string, repo: string, path: string, options: { method?: string; body?: unknown; acceptedStatuses?: number[] } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("GitHub API timed out", "TimeoutError")), 20_000);
  try {
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${automationToken}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "Nucleus-AI-Builder",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const accepted = options.acceptedStatuses ?? [200, 201];
    const text = await response.text();
    const data = text ? JSON.parse(text) as T & { message?: string } : {} as T & { message?: string };
    if (!accepted.includes(response.status)) throw new GitAutomationError(data.message || `GitHub API 返回 ${response.status}`, response.status);
    return data;
  } catch (error) {
    if (error instanceof GitAutomationError) throw error;
    throw new GitAutomationError(error instanceof Error ? error.message : "GitHub API 请求失败", 502);
  } finally {
    clearTimeout(timer);
  }
}

function integrationFromRow(row: D1Row): GitIntegration {
  return {
    projectId: String(row.project_id),
    provider: "github",
    repositoryOwner: String(row.repository_owner),
    repositoryName: String(row.repository_name),
    defaultBranch: String(row.default_branch),
    installationId: row.installation_id ? String(row.installation_id) : null,
    status: String(row.status) as GitIntegration["status"],
    lastSync: parseJson<GitSyncResult | null>(row.last_sync_json, null),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function safeSegment(value: string, label: string): string {
  const clean = value.trim();
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(clean)) throw new GitAutomationError(`${label}格式无效`);
  return clean;
}

function safeBranch(value: string): string {
  const clean = value.trim();
  if (!/^[a-zA-Z0-9._/-]{1,120}$/.test(clean) || clean.includes("..") || clean.startsWith("/") || clean.endsWith("/")) throw new GitAutomationError("默认分支名称无效");
  return clean;
}

function prettyJson(value: string): string {
  try { return `${JSON.stringify(JSON.parse(value), null, 2)}\n`; } catch { return value; }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
