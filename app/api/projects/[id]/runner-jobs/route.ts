import { createRunnerJob, listRunnerJobs } from "@/lib/app-platform-db";
import { getProject } from "@/lib/db";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { OrganizationError, requireProjectOrganizationRole } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";
import { dispatchContainerJob, dispatchPlaywrightJob, RunnerProviderError } from "@/lib/runner-provider";
import type { RunnerJob } from "@/lib/types";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, context, async (id) => ({ jobs: await listRunnerJobs(id) }));
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, context, async (id, project) => {
    const body = await request.json().catch(() => ({})) as { kind?: RunnerJob["kind"]; viewport?: string };
    const kind = body.kind === "container-build" ? "container-build" : "playwright";
    const publicUrl = project.slug ? `${new URL(request.url).origin}/p/${project.slug}` : null;
    if (kind === "playwright" && !publicUrl) throw new RunnerProviderError("请先发布当前应用，再执行公网 Playwright 点击验收", 409);
    if (kind === "container-build" && !project.manifest) throw new RunnerProviderError("当前应用还没有可交付给容器 Runner 的 Manifest", 409);
    let job = await createRunnerJob({ projectId: id, versionId: project.currentVersionId, kind, request: { publicUrl, viewport: body.viewport ?? "desktop", acceptance: project.manifest?.acceptance.checks ?? [] } });
    if (kind === "playwright" && job.status === "queued") job = await dispatchPlaywrightJob(job, new URL(request.url).origin);
    if (kind === "container-build" && job.status === "queued" && project.manifest) job = await dispatchContainerJob(job, new URL(request.url).origin, { files: project.files, manifest: project.manifest });
    return { job };
  }, 201);
}

async function handle(request: Request, context: { params: Promise<{ id: string }> }, action: (id: string, project: NonNullable<Awaited<ReturnType<typeof getProject>>>) => Promise<unknown>, successStatus = 200) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id } = await context.params;
    const project = await getProject(id, identity.ownerId);
    if (!project) return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    if (request.method === "POST") await requireProjectOrganizationRole(id, identity.ownerId, ["owner", "admin", "editor"]);
    return withWorkspaceIdentity(Response.json(await action(id, project), { status: successStatus }), identity);
  } catch (error) {
    const status = error instanceof RunnerProviderError || error instanceof OrganizationError ? error.status : 500;
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "Runner 任务操作失败" }, { status }), visitor);
  }
}
