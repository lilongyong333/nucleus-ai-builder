import { getRequestExecutionContext } from "vinext/shims/request-context";

export function scheduleProjectDatabaseProvisioning(projectId: string): void {
  const work = import("./database-provisioner").then(({ ensureProjectDatabase }) => ensureProjectDatabase(projectId)).catch(async (error) => {
    const message = error instanceof Error ? error.message : "应用数据库异步创建失败";
    await import("./observability").then(({ recordServiceEvent }) => recordServiceEvent({ projectId, service: "database", operation: "provision.background", level: "error", message, detail: { recoverableByMaintenance: true } })).catch(() => undefined);
  });
  const context = getRequestExecutionContext();
  if (context) context.waitUntil(work);
  else void work;
}
