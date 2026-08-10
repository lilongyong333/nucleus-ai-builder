import { env } from "cloudflare:workers";
import { ensureSchema } from "./db";
import type { OperationalSummary } from "./types";

type D1Row = Record<string, string | number | null>;

function database(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error("可观测性数据库暂不可用");
  return binding;
}

export async function recordServiceEvent(input: {
  projectId?: string | null;
  organizationId?: string | null;
  service: string;
  operation: string;
  level: "info" | "warn" | "error";
  durationMs?: number | null;
  statusCode?: number | null;
  message: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  const detail = boundedObject(input.detail ?? {});
  await database().prepare(`INSERT INTO service_events (id,project_id,organization_id,service,operation,level,duration_ms,status_code,message,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
    crypto.randomUUID(), input.projectId ?? null, input.organizationId ?? null, input.service.slice(0, 80), input.operation.slice(0, 120), input.level, input.durationMs ?? null, input.statusCode ?? null, input.message.slice(0, 1_000), JSON.stringify(detail), now,
  ).run();
  if (input.level === "error") await dispatchOperationalAlert({ ...input, detail, createdAt: now }).catch(() => undefined);
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
  const target = 0.99;
  return { windowMinutes: boundedWindow, total, errors, errorRate, p95DurationMs, slo: { target, healthy: total === 0 || 1 - errorRate >= target }, alerting: alertingConfigured() ? "ready" : "configuration-required" };
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
      await dispatchOperationalAlert({ projectId, service: "nucleus", operation: "slo.error-rate", level: "error", message: `过去 60 分钟错误率 ${(summary.errorRate * 100).toFixed(2)}%，超过 1% 预算`, detail: summary, createdAt: new Date().toISOString() }).catch(() => undefined);
    }
  }
  return { evaluated: projects.results?.length ?? 0, breached };
}

export function alertingConfigured(): boolean {
  const runtime = env as unknown as Record<string, unknown>;
  return Boolean(stringEnv(runtime.NUCLEUS_ALERT_WEBHOOK_URL) || stringEnv(runtime.SENTRY_DSN));
}

async function dispatchOperationalAlert(event: Record<string, unknown>): Promise<void> {
  const runtime = env as unknown as Record<string, unknown>;
  const webhook = stringEnv(runtime.NUCLEUS_ALERT_WEBHOOK_URL);
  const sentryDsn = stringEnv(runtime.SENTRY_DSN);
  const requests: Promise<unknown>[] = [];
  if (webhook) {
    const parsed = new URL(webhook);
    if (parsed.protocol !== "https:") throw new Error("告警 Webhook 必须使用 HTTPS");
    requests.push(fetch(parsed, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "nucleus", event }) }));
  }
  if (sentryDsn) requests.push(sendSentryEvent(sentryDsn, event));
  await Promise.all(requests);
}

async function sendSentryEvent(dsn: string, event: Record<string, unknown>): Promise<void> {
  const parsed = new URL(dsn);
  const projectId = parsed.pathname.split("/").filter(Boolean).at(-1);
  const publicKey = parsed.username;
  if (parsed.protocol !== "https:" || !projectId || !publicKey) throw new Error("SENTRY_DSN 格式无效");
  const envelopeUrl = `${parsed.protocol}//${parsed.host}/api/${encodeURIComponent(projectId)}/envelope/`;
  const eventId = crypto.randomUUID().replaceAll("-", "");
  const header = JSON.stringify({ event_id: eventId, dsn });
  const payload = JSON.stringify({
    event_id: eventId,
    timestamp: new Date().toISOString(),
    level: "error",
    platform: "javascript",
    logger: "nucleus.control-plane",
    message: String(event.message ?? "Nucleus operational error"),
    tags: { service: String(event.service ?? "nucleus"), operation: String(event.operation ?? "unknown"), project_id: String(event.projectId ?? "") },
    extra: boundedObject(event),
  });
  await fetch(envelopeUrl, { method: "POST", headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7,sentry_key=${publicKey},sentry_client=nucleus/1.0` }, body: `${header}\n${JSON.stringify({ type: "event", length: new TextEncoder().encode(payload).length })}\n${payload}` });
}

function boundedObject(value: Record<string, unknown>): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= 32_000 ? value : { truncated: true, bytes: serialized.length };
  } catch {
    return { serializationError: true };
  }
}

function stringEnv(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
