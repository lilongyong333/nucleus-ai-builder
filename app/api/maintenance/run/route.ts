import { env } from "cloudflare:workers";
import { runDueAppBackups } from "@/lib/app-platform-db";
import { exportPendingMeterUsage } from "@/lib/billing";
import { deleteDueProjectDatabases, reconcileProjectDatabases } from "@/lib/database-provisioner";
import { ensureSchema } from "@/lib/db";
import { evaluateOperationalSlos, recordServiceEvent, retryPendingOperationalAlerts } from "@/lib/observability";
import { retryPendingNotifications } from "@/lib/notifications";

export const maxDuration = 60;

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    authorize(request);
    await ensureSchema();
    const [databases, backups, deletedDatabases, billing, notifications, alertDeliveries, slos, cleanup] = await Promise.all([
      reconcileProjectDatabases(5),
      runDueAppBackups(20),
      deleteDueProjectDatabases(20).catch((error) => ({ deleted: [], failed: [{ projectId: "control-plane", error: error instanceof Error ? error.message : "清理失败" }] })),
      exportPendingMeterUsage(100).catch(() => ({ exported: 0, failed: 0, skipped: 1 })),
      retryPendingNotifications(20),
      retryPendingOperationalAlerts(20),
      evaluateOperationalSlos(),
      cleanupExpiredControlPlaneRows(),
    ]);
    const result = { databases, backups, deletedDatabases, billing, notifications, alertDeliveries, slos, cleanup, durationMs: Date.now() - startedAt, completedAt: new Date().toISOString() };
    await recordServiceEvent({ service: "control-plane", operation: "maintenance", level: databases.failed.length || backups.failed.length || deletedDatabases.failed.length || billing.failed || notifications.failed || alertDeliveries.failed ? "warn" : "info", durationMs: result.durationMs, message: "定时维护任务完成", detail: result }).catch(() => undefined);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof MaintenanceError ? error.status : 500;
    await recordServiceEvent({ service: "control-plane", operation: "maintenance", level: "error", durationMs: Date.now() - startedAt, statusCode: status, message: error instanceof Error ? error.message : "定时维护失败" }).catch(() => undefined);
    return Response.json({ error: error instanceof Error ? error.message : "定时维护失败" }, { status, headers: { "Cache-Control": "no-store" } });
  }
}

class MaintenanceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function authorize(request: Request): void {
  const runtime = env as unknown as Record<string, unknown>;
  const expected = typeof runtime.NUCLEUS_MAINTENANCE_TOKEN === "string" ? runtime.NUCLEUS_MAINTENANCE_TOKEN.trim() : "";
  const actual = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  if (!expected) throw new MaintenanceError("维护任务密钥尚未配置", 503);
  if (!timingSafeEqual(actual, expected)) throw new MaintenanceError("维护任务签名无效", 401);
}

async function cleanupExpiredControlPlaneRows(): Promise<{ sessions: number; oauthStates: number; limits: number }> {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new MaintenanceError("维护数据库不可用", 503);
  const now = new Date().toISOString();
  const [sessions, oauthStates, limits] = await binding.batch([
    binding.prepare(`DELETE FROM app_sessions WHERE expires_at<?`).bind(now),
    binding.prepare(`DELETE FROM oauth_states WHERE expires_at<? OR (consumed_at IS NOT NULL AND consumed_at<?)`).bind(now, new Date(Date.now() - 24 * 60 * 60_000).toISOString()),
    binding.prepare(`DELETE FROM generation_limits WHERE expires_at<?`).bind(now),
  ]);
  return { sessions: Number(sessions.meta.changes ?? 0), oauthStates: Number(oauthStates.meta.changes ?? 0), limits: Number(limits.meta.changes ?? 0) };
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
