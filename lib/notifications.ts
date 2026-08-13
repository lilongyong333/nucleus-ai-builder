import { env } from "cloudflare:workers";
import { ensureSchema } from "./db";
import type { NotificationDelivery } from "./types";
import { boundedExponentialDelayMs } from "./retry-policy";

type D1Row = Record<string, string | number | null>;
type InvitePayload = {
  organizationName: string;
  inviterName: string;
  role: string;
  origin: string;
};

const MAX_DELIVERY_ATTEMPTS = 8;

export class NotificationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "NotificationError";
  }
}

function database(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new NotificationError("通知控制面数据库暂不可用", 503);
  return binding;
}

/**
 * Outbox-first delivery: the invitation is committed before the provider call.
 * A Worker crash can therefore be repaired by the scheduled maintenance task.
 */
export async function sendOrganizationInviteEmail(input: { organizationId: string; projectId?: string; organizationName: string; recipient: string; inviterName: string; role: string; origin: string }): Promise<NotificationDelivery> {
  await ensureSchema();
  const recipient = normalizeEmail(input.recipient);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const payload: InvitePayload = {
    organizationName: input.organizationName.trim().slice(0, 160) || "Nucleus 团队",
    inviterName: input.inviterName.trim().slice(0, 160) || "团队管理员",
    role: input.role.trim().slice(0, 60) || "editor",
    origin: normalizeOrigin(input.origin),
  };
  await database().prepare(`INSERT INTO notification_deliveries (id,organization_id,project_id,kind,channel,recipient,status,provider,provider_message_id,error,payload_json,attempts,next_attempt_at,last_attempt_at,created_at,delivered_at) VALUES (?,?,?,'organization-invite','email',?,'queued','resend',NULL,NULL,?,0,?,NULL,?,NULL)`).bind(
    id, input.organizationId, input.projectId ?? null, recipient, JSON.stringify(payload), now, now,
  ).run();
  return deliverNotification(id);
}

export async function retryPendingNotifications(limit = 20): Promise<{ attempted: number; sent: number; failed: number; configurationRequired: number }> {
  await ensureSchema();
  const now = new Date().toISOString();
  const result = await database().prepare(`SELECT id FROM notification_deliveries WHERE status IN ('queued','failed','configuration-required') AND attempts<? AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at ASC LIMIT ?`).bind(MAX_DELIVERY_ATTEMPTS, now, Math.max(1, Math.min(100, Math.floor(limit)))).all<D1Row>();
  let sent = 0;
  let failed = 0;
  let configurationRequired = 0;
  for (const row of result.results ?? []) {
    const delivery = await deliverNotification(String(row.id));
    if (delivery.status === "sent") sent += 1;
    else if (delivery.status === "configuration-required") configurationRequired += 1;
    else failed += 1;
  }
  return { attempted: result.results?.length ?? 0, sent, failed, configurationRequired };
}

export async function listNotificationDeliveries(projectId: string, limit = 30): Promise<NotificationDelivery[]> {
  await ensureSchema();
  const result = await database().prepare(`SELECT * FROM notification_deliveries WHERE project_id=? ORDER BY created_at DESC LIMIT ?`).bind(projectId, Math.max(1, Math.min(100, limit))).all<D1Row>();
  return (result.results ?? []).map(deliveryFromRow);
}

export function notificationRetryDelayMs(attempt: number): number {
  return boundedExponentialDelayMs(attempt, 60_000, MAX_DELIVERY_ATTEMPTS);
}

async function deliverNotification(id: string): Promise<NotificationDelivery> {
  const row = await database().prepare(`SELECT * FROM notification_deliveries WHERE id=?`).bind(id).first<D1Row>();
  if (!row) throw new NotificationError("通知任务不存在", 404);
  if (row.status === "sent") return deliveryFromRow(row);
  const attempt = Number(row.attempts ?? 0) + 1;
  const attemptedAt = new Date().toISOString();
  const runtime = env as unknown as Record<string, unknown>;
  const apiKey = stringEnv(runtime.RESEND_API_KEY);
  const from = stringEnv(runtime.NUCLEUS_EMAIL_FROM);
  const payload = parseInvitePayload(row.payload_json);
  if (!payload) {
    await markDeliveryFailed(id, attempt, attemptedAt, "通知任务载荷已损坏", false);
    return (await getDelivery(id))!;
  }
  if (!apiKey || !from) {
    const nextAttemptAt = new Date(Date.now() + notificationRetryDelayMs(attempt)).toISOString();
    await database().prepare(`UPDATE notification_deliveries SET status='configuration-required',attempts=?,last_attempt_at=?,next_attempt_at=?,error='缺少 RESEND_API_KEY 或 NUCLEUS_EMAIL_FROM' WHERE id=? AND status<>'sent'`).bind(attempt, attemptedAt, nextAttemptAt, id).run();
    return (await getDelivery(id))!;
  }

  const invitationUrl = new URL("/account", payload.origin).toString();
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `nucleus-invite/${id}` },
      body: JSON.stringify({
        from,
        to: [String(row.recipient)],
        subject: `${payload.inviterName} 邀请你加入 ${payload.organizationName}`,
        text: `${payload.inviterName} 邀请你以 ${payload.role} 身份加入 ${payload.organizationName}。使用 ${row.recipient} 登录 Nucleus 后会自动加入：${invitationUrl}`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;padding:32px"><h1 style="font-size:26px">加入 ${escapeHtml(payload.organizationName)}</h1><p>${escapeHtml(payload.inviterName)} 邀请你以 <strong>${escapeHtml(payload.role)}</strong> 身份协作。</p><p>请使用 <strong>${escapeHtml(String(row.recipient))}</strong> 登录，系统会自动认领邀请。</p><p><a href="${escapeHtml(invitationUrl)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#171815;color:#fff;text-decoration:none">接受邀请</a></p><p style="color:#777;font-size:12px">如果你不认识邀请人，可以忽略这封邮件。</p></div>`,
      }),
    });
    const data = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok || !data.id) throw new NotificationError(data.message || `Resend 返回 ${response.status}`, 502);
    await database().prepare(`UPDATE notification_deliveries SET status='sent',provider_message_id=?,error=NULL,attempts=?,last_attempt_at=?,next_attempt_at=NULL,delivered_at=? WHERE id=? AND status<>'sent'`).bind(data.id, attempt, attemptedAt, new Date().toISOString(), id).run();
  } catch (error) {
    await markDeliveryFailed(id, attempt, attemptedAt, error instanceof Error ? error.message : "邮件发送失败", attempt < MAX_DELIVERY_ATTEMPTS);
  }
  return (await getDelivery(id))!;
}

async function markDeliveryFailed(id: string, attempt: number, attemptedAt: string, message: string, retryable: boolean): Promise<void> {
  const nextAttemptAt = retryable ? new Date(Date.now() + notificationRetryDelayMs(attempt)).toISOString() : null;
  await database().prepare(`UPDATE notification_deliveries SET status='failed',attempts=?,last_attempt_at=?,next_attempt_at=?,error=? WHERE id=? AND status<>'sent'`).bind(attempt, attemptedAt, nextAttemptAt, message.slice(0, 800), id).run();
}

async function getDelivery(id: string): Promise<NotificationDelivery | null> {
  const row = await database().prepare(`SELECT * FROM notification_deliveries WHERE id=?`).bind(id).first<D1Row>();
  return row ? deliveryFromRow(row) : null;
}

function deliveryFromRow(row: D1Row): NotificationDelivery {
  return {
    id: String(row.id), kind: String(row.kind), channel: "email", recipient: String(row.recipient), status: String(row.status) as NotificationDelivery["status"], provider: "resend",
    providerMessageId: row.provider_message_id ? String(row.provider_message_id) : null,
    error: row.error ? String(row.error) : null,
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null,
    lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : null,
    createdAt: String(row.created_at), deliveredAt: row.delivered_at ? String(row.delivered_at) : null,
  };
}

function parseInvitePayload(value: unknown): InvitePayload | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as Partial<InvitePayload> : null;
    if (!parsed || typeof parsed.organizationName !== "string" || typeof parsed.inviterName !== "string" || typeof parsed.role !== "string" || typeof parsed.origin !== "string") return null;
    return { organizationName: parsed.organizationName, inviterName: parsed.inviterName, role: parsed.role, origin: normalizeOrigin(parsed.origin) };
  } catch {
    return null;
  }
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new NotificationError("通知邮箱格式无效");
  return email;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new NotificationError("邀请链接必须使用 HTTPS", 500);
  return url.origin;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function stringEnv(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
