import { env } from "cloudflare:workers";
import { ensureSchema } from "./db";
import type { OperationalSummary } from "./types";
import { boundedExponentialDelayMs } from "./retry-policy";

type D1Row = Record<string, string | number | null>;
type ServiceEventInput = {
  projectId?: string | null;
  organizationId?: string | null;
  service: string;
  operation: string;
  level: "info" | "warn" | "error";
  durationMs?: number | null;
  statusCode?: number | null;
  message: string;
  detail?: Record<string, unknown>;
};

const MAX_ALERT_ATTEMPTS = 8;

function database(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error("可观测性数据库暂不可用");
  return binding;
}

export async function recordServiceEvent(input: ServiceEventInput): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  const detail = boundedObject(input.detail ?? {});
  await database().prepare(`INSERT INTO service_events (id,project_id,organization_id,service,operation,level,duration_ms,status_code,message,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
    crypto.randomUUID(), input.projectId ?? null, input.organizationId ?? null, input.service.slice(0, 80), input.operation.slice(0, 120), input.level, input.durationMs ?? null, input.statusCode ?? null, input.message.slice(0, 1_000), JSON.stringify(detail), now,
  ).run();
  if (input.level === "error") await queueOperationalAlert({ ...input, detail, createdAt: now }).catch(() => undefined);
}

export async function operationalSummary(projectId: string, windowMinutes = 60): Promise<OperationalSummary> {
  await ensureSchema();
  const boundedWindow = Math.max(5, Math.min(7 * 24 * 60, Math.floor(windowMinutes)));
  const since = new Date(Date.now() - boundedWindow * 60_000).toISOString();
  const result = await database().prepare(`SELECT level,duration_ms FROM service_events WHERE project_id=? AND created_at>=? ORDER BY duration_ms ASC`).bind(projectId, since).all<D1Row>();
  const rows = result.results ?? [];
  const total = rows.length;
  const errors = rows.filter((row) => row.level === "error").length;
  const durations = rows.map((row) => Number(row.duration_ms)).filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  const p95DurationMs = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : null;
  const errorRate = total ? errors / total : 0;
  const target = boundedNumber(runtimeValue("NUCLEUS_SLO_TARGET"), 0.99, 0.9, 0.9999);
  const latencyTargetMs = boundedNumber(runtimeValue("NUCLEUS_SLO_P95_MS"), 5_000, 100, 120_000);
  const availabilityHealthy = total === 0 || 1 - errorRate >= target;
  const latencyHealthy = p95DurationMs === null || p95DurationMs <= latencyTargetMs;
  return {
    windowMinutes: boundedWindow,
    total,
    errors,
    errorRate,
    p95DurationMs,
    slo: { target, healthy: availabilityHealthy && latencyHealthy, availabilityHealthy, latencyHealthy, latencyTargetMs },
    alerting: alertingConfigured() ? "ready" : "configuration-required",
  };
}

export async function evaluateOperationalSlos(): Promise<{ evaluated: number; breached: number }> {
  await ensureSchema();
  const projects = await database().prepare(`SELECT DISTINCT project_id FROM service_events WHERE project_id IS NOT NULL AND created_at>=? LIMIT 500`).bind(new Date(Date.now() - 60 * 60_000).toISOString()).all<D1Row>();
  let breached = 0;
  for (const row of projects.results ?? []) {
    const projectId = String(row.project_id);
    const summary = await operationalSummary(projectId, 60);
    if (!summary.slo.healthy && summary.total >= 10) {
      breached += 1;
      const reasons = [
        !summary.slo.availabilityHealthy ? `错误率 ${(summary.errorRate * 100).toFixed(2)}%` : null,
        !summary.slo.latencyHealthy ? `P95 ${summary.p95DurationMs}ms` : null,
      ].filter(Boolean).join("，");
      await queueOperationalAlert({ projectId, service: "nucleus", operation: "slo.breach", level: "error", message: `过去 60 分钟 SLO 违约：${reasons}`, detail: summary, createdAt: new Date().toISOString() }).catch(() => undefined);
    }
  }
  return { evaluated: projects.results?.length ?? 0, breached };
}

export async function retryPendingOperationalAlerts(limit = 20): Promise<{ attempted: number; sent: number; failed: number; configurationRequired: number }> {
  await ensureSchema();
  const now = new Date().toISOString();
  const result = await database().prepare(`SELECT id FROM operational_alerts WHERE status IN ('queued','failed','configuration-required') AND attempts<? AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at ASC LIMIT ?`).bind(MAX_ALERT_ATTEMPTS, now, Math.max(1, Math.min(100, Math.floor(limit)))).all<D1Row>();
  let sent = 0;
  let failed = 0;
  let configurationRequired = 0;
  for (const row of result.results ?? []) {
    const status = await deliverOperationalAlert(String(row.id));
    if (status === "sent") sent += 1;
    else if (status === "configuration-required") configurationRequired += 1;
    else failed += 1;
  }
  return { attempted: result.results?.length ?? 0, sent, failed, configurationRequired };
}

export function alertingConfigured(): boolean {
  return Boolean(stringEnv(runtimeValue("NUCLEUS_ALERT_WEBHOOK_URL")) || stringEnv(runtimeValue("SENTRY_DSN")));
}

export function alertRetryDelayMs(attempt: number): number {
  return boundedExponentialDelayMs(attempt, 60_000, MAX_ALERT_ATTEMPTS);
}

async function queueOperationalAlert(event: Record<string, unknown>): Promise<void> {
  const createdAt = typeof event.createdAt === "string" ? event.createdAt : new Date().toISOString();
  const fingerprint = await digest(`${event.projectId ?? "global"}|${event.organizationId ?? "global"}|${event.service ?? "nucleus"}|${event.operation ?? "unknown"}`);
  const cooldownMinutes = boundedNumber(runtimeValue("NUCLEUS_ALERT_COOLDOWN_MINUTES"), 30, 1, 24 * 60);
  const duplicate = await database().prepare(`SELECT id FROM operational_alerts WHERE fingerprint=? AND status IN ('queued','sent','failed','configuration-required') AND created_at>=? ORDER BY created_at DESC LIMIT 1`).bind(fingerprint, new Date(Date.now() - cooldownMinutes * 60_000).toISOString()).first<D1Row>();
  const id = crypto.randomUUID();
  if (duplicate) {
    await database().prepare(`INSERT INTO operational_alerts (id,fingerprint,project_id,organization_id,service,operation,severity,status,payload_json,attempts,next_attempt_at,last_error,created_at,sent_at) VALUES (?,?,?,?,?,?,?,'suppressed',?,0,NULL,NULL,?,NULL)`).bind(
      id, fingerprint, nullableString(event.projectId), nullableString(event.organizationId), safeString(event.service, "nucleus", 80), safeString(event.operation, "unknown", 120), safeString(event.level, "error", 20), JSON.stringify(boundedObject(event)), createdAt,
    ).run();
    return;
  }
  await database().prepare(`INSERT INTO operational_alerts (id,fingerprint,project_id,organization_id,service,operation,severity,status,payload_json,attempts,next_attempt_at,last_error,created_at,sent_at) VALUES (?,?,?,?,?,?,?,'queued',?,0,?,NULL,?,NULL)`).bind(
    id, fingerprint, nullableString(event.projectId), nullableString(event.organizationId), safeString(event.service, "nucleus", 80), safeString(event.operation, "unknown", 120), safeString(event.level, "error", 20), JSON.stringify(boundedObject(event)), createdAt, createdAt,
  ).run();
  await deliverOperationalAlert(id);
}

async function deliverOperationalAlert(id: string): Promise<"sent" | "failed" | "configuration-required" | "suppressed"> {
  const row = await database().prepare(`SELECT * FROM operational_alerts WHERE id=?`).bind(id).first<D1Row>();
  if (!row) return "failed";
  if (row.status === "sent" || row.status === "suppressed") return String(row.status) as "sent" | "suppressed";
  const attempt = Number(row.attempts ?? 0) + 1;
  const webhook = stringEnv(runtimeValue("NUCLEUS_ALERT_WEBHOOK_URL"));
  const sentryDsn = stringEnv(runtimeValue("SENTRY_DSN"));
  if (!webhook && !sentryDsn) {
    await updateAlertFailure(id, attempt, "告警 Webhook 与 Sentry DSN 均未配置", "configuration-required");
    return "configuration-required";
  }
  const event = parseObject(row.payload_json);
  try {
    const deliveries: Promise<void>[] = [];
    if (webhook) deliveries.push(sendWebhook(webhook, id, event));
    if (sentryDsn) deliveries.push(sendSentryEvent(sentryDsn, id, event));
    await Promise.all(deliveries);
    await database().prepare(`UPDATE operational_alerts SET status='sent',attempts=?,next_attempt_at=NULL,last_error=NULL,sent_at=? WHERE id=? AND status<>'sent'`).bind(attempt, new Date().toISOString(), id).run();
    return "sent";
  } catch (error) {
    await updateAlertFailure(id, attempt, error instanceof Error ? error.message : "告警投递失败", "failed");
    return "failed";
  }
}

async function updateAlertFailure(id: string, attempt: number, error: string, status: "failed" | "configuration-required"): Promise<void> {
  const nextAttemptAt = attempt < MAX_ALERT_ATTEMPTS ? new Date(Date.now() + alertRetryDelayMs(attempt)).toISOString() : null;
  await database().prepare(`UPDATE operational_alerts SET status=?,attempts=?,next_attempt_at=?,last_error=? WHERE id=? AND status<>'sent'`).bind(status, attempt, nextAttemptAt, error.slice(0, 1_000), id).run();
}

async function sendWebhook(value: string, alertId: string, event: Record<string, unknown>): Promise<void> {
  const webhook = new URL(value);
  if (webhook.protocol !== "https:") throw new Error("告警 Webhook 必须使用 HTTPS");
  const response = await fetchWithTimeout(webhook, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `nucleus-alert/${alertId}` }, body: JSON.stringify({ source: "nucleus", alertId, event }) });
  if (!response.ok) throw new Error(`告警 Webhook 返回 ${response.status}`);
}

async function sendSentryEvent(dsn: string, alertId: string, event: Record<string, unknown>): Promise<void> {
  const parsed = new URL(dsn);
  const projectId = parsed.pathname.split("/").filter(Boolean).at(-1);
  const publicKey = parsed.username;
  if (parsed.protocol !== "https:" || !projectId || !publicKey) throw new Error("SENTRY_DSN 格式无效");
  const envelopeUrl = `${parsed.protocol}//${parsed.host}/api/${encodeURIComponent(projectId)}/envelope/`;
  const eventId = (await digest(alertId)).slice(0, 32);
  const header = JSON.stringify({ event_id: eventId, dsn });
  const payload = JSON.stringify({
    event_id: eventId,
    timestamp: new Date().toISOString(),
    level: "error",
    platform: "javascript",
    logger: "nucleus.control-plane",
    message: String(event.message ?? "Nucleus operational error"),
    tags: { service: String(event.service ?? "nucleus"), operation: String(event.operation ?? "unknown"), project_id: String(event.projectId ?? ""), alert_id: alertId },
    extra: boundedObject(event),
  });
  const response = await fetchWithTimeout(envelopeUrl, { method: "POST", headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7,sentry_key=${publicKey},sentry_client=nucleus/1.0` }, body: `${header}\n${JSON.stringify({ type: "event", length: new TextEncoder().encode(payload).length })}\n${payload}` });
  if (!response.ok) throw new Error(`Sentry 返回 ${response.status}`);
}

async function fetchWithTimeout(input: string | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("alert delivery timed out", "TimeoutError")), 10_000);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function boundedObject(value: Record<string, unknown>): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= 32_000 ? value : { truncated: true, bytes: serialized.length };
  } catch {
    return { serializationError: true };
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  try { return typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : {}; } catch { return {}; }
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function runtimeValue(name: string): unknown {
  return (env as unknown as Record<string, unknown>)[name] ?? process.env[name];
}

function stringEnv(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function safeString(value: unknown, fallback: string, maximum: number): string {
  return typeof value === "string" && value ? value.slice(0, maximum) : fallback;
}
