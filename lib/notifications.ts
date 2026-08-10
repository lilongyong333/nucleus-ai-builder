import { env } from "cloudflare:workers";
import { ensureSchema } from "./db";
import type { NotificationDelivery } from "./types";

type D1Row = Record<string, string | number | null>;

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

export async function sendOrganizationInviteEmail(input: { organizationId: string; projectId?: string; organizationName: string; recipient: string; inviterName: string; role: string; origin: string }): Promise<NotificationDelivery> {
  await ensureSchema();
  const runtime = env as unknown as Record<string, unknown>;
  const apiKey = stringEnv(runtime.RESEND_API_KEY);
  const from = stringEnv(runtime.NUCLEUS_EMAIL_FROM);
  const recipient = input.recipient.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(recipient)) throw new NotificationError("通知邮箱格式无效");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  if (!apiKey || !from) {
    await insertDelivery({ id, organizationId: input.organizationId, projectId: input.projectId ?? null, recipient, status: "configuration-required", providerMessageId: null, error: "缺少 RESEND_API_KEY 或 NUCLEUS_EMAIL_FROM", createdAt: now, deliveredAt: null });
    return (await getDelivery(id))!;
  }

  const invitationUrl = new URL("/account", normalizeOrigin(input.origin)).toString();
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `nucleus-invite/${id}` },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject: `${input.inviterName} 邀请你加入 ${input.organizationName}`,
        text: `${input.inviterName} 邀请你以 ${input.role} 身份加入 ${input.organizationName}。使用 ${recipient} 登录 Nucleus 后会自动加入：${invitationUrl}`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;padding:32px"><h1 style="font-size:26px">加入 ${escapeHtml(input.organizationName)}</h1><p>${escapeHtml(input.inviterName)} 邀请你以 <strong>${escapeHtml(input.role)}</strong> 身份协作。</p><p>请使用 <strong>${escapeHtml(recipient)}</strong> 登录，系统会自动认领邀请。</p><p><a href="${escapeHtml(invitationUrl)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#171815;color:#fff;text-decoration:none">接受邀请</a></p><p style="color:#777;font-size:12px">如果你不认识邀请人，可以忽略这封邮件。</p></div>`,
      }),
    });
    const data = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok || !data.id) throw new NotificationError(data.message || `Resend 返回 ${response.status}`, 502);
    await insertDelivery({ id, organizationId: input.organizationId, projectId: input.projectId ?? null, recipient, status: "sent", providerMessageId: data.id, error: null, createdAt: now, deliveredAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "邮件发送失败";
    await insertDelivery({ id, organizationId: input.organizationId, projectId: input.projectId ?? null, recipient, status: "failed", providerMessageId: null, error: message.slice(0, 800), createdAt: now, deliveredAt: null });
  }
  return (await getDelivery(id))!;
}

export async function listNotificationDeliveries(projectId: string, limit = 30): Promise<NotificationDelivery[]> {
  await ensureSchema();
  const result = await database().prepare(`SELECT * FROM notification_deliveries WHERE project_id=? ORDER BY created_at DESC LIMIT ?`).bind(projectId, Math.max(1, Math.min(100, limit))).all<D1Row>();
  return (result.results ?? []).map(deliveryFromRow);
}

async function insertDelivery(input: { id: string; organizationId: string; projectId: string | null; recipient: string; status: NotificationDelivery["status"]; providerMessageId: string | null; error: string | null; createdAt: string; deliveredAt: string | null }): Promise<void> {
  await database().prepare(`INSERT INTO notification_deliveries (id,organization_id,project_id,kind,channel,recipient,status,provider,provider_message_id,error,created_at,delivered_at) VALUES (?,?,?,'organization-invite','email',?,?,'resend',?,?,?,?)`).bind(input.id, input.organizationId, input.projectId, input.recipient, input.status, input.providerMessageId, input.error, input.createdAt, input.deliveredAt).run();
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
    createdAt: String(row.created_at), deliveredAt: row.delivered_at ? String(row.delivered_at) : null,
  };
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  return url.origin;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function stringEnv(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
