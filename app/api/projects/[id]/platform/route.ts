import { getAppManifest, listAppBackups, listRunnerJobs, listRuntimeEvidence, runtimePlatformStats } from "@/lib/app-platform-db";
import { getDatabaseResource, listProvisioningEvents } from "@/lib/database-provisioner";
import { getProject } from "@/lib/db";
import { getGitIntegration } from "@/lib/github-automation";
import { resolveWorkspaceIdentity, withWorkspaceIdentity } from "@/lib/identity";
import { getProjectOrganization, listProjectApprovals } from "@/lib/organization-db";
import { resolveVisitorSession, withVisitorSession } from "@/lib/session";
import { getBillingAccount } from "@/lib/billing";
import { listGitHubAppInstallations } from "@/lib/github-app";
import { listNotificationDeliveries } from "@/lib/notifications";
import { operationalSummary } from "@/lib/observability";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const visitor = resolveVisitorSession(request);
  try {
    const identity = await resolveWorkspaceIdentity(request, visitor);
    const { id } = await context.params;
    const project = await getProject(id, identity.ownerId);
    if (!project) return withWorkspaceIdentity(Response.json({ error: "项目不存在或无权访问" }, { status: 404 }), identity);
    const [manifest, stats, evidence, backups, runnerJobs, organization, approvals, git, databaseResource, provisioningEvents, githubInstallations, notifications, operations] = await Promise.all([
      getAppManifest(id),
      runtimePlatformStats(id),
      listRuntimeEvidence(id, 40),
      listAppBackups(id),
      listRunnerJobs(id),
      getProjectOrganization(id, identity.ownerId),
      listProjectApprovals(id, identity.ownerId),
      getGitIntegration(id),
      getDatabaseResource(id),
      listProvisioningEvents(id),
      listGitHubAppInstallations(identity.ownerId),
      listNotificationDeliveries(id),
      operationalSummary(id),
    ]);
    const billing = organization ? await getBillingAccount(organization.id) : null;
    return withWorkspaceIdentity(Response.json({ manifest, stats, evidence, backups, runnerJobs, organization, approvals, git, databaseResource, provisioningEvents, githubInstallations, notifications, billing, operations }), identity);
  } catch (error) {
    return withVisitorSession(Response.json({ error: error instanceof Error ? error.message : "读取应用平台状态失败" }, { status: 500 }), visitor);
  }
}
