import { env } from "cloudflare:workers";
import { ensureSchema } from "./db";
import { verifyStripeWebhookSignature } from "./stripe-signature";
import type { BillingAccount } from "./types";

type D1Row = Record<string, string | number | null>;
type StripeObject = Record<string, unknown> & { id?: string; customer?: string; subscription?: string; status?: string; current_period_end?: number; metadata?: Record<string, string> };

export class BillingError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "BillingError";
  }
}

type BillingConfig = { secretKey: string; webhookSecret: string | null; teamPrice: string | null; enterprisePrice: string | null; meterEventName: string | null };

function database(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new BillingError("计费控制面数据库暂不可用", 503);
  return binding;
}

function configuration(requireWebhook = false): BillingConfig {
  const runtime = env as unknown as Record<string, unknown>;
  const config = {
    secretKey: stringEnv(runtime.STRIPE_SECRET_KEY) ?? "",
    webhookSecret: stringEnv(runtime.STRIPE_WEBHOOK_SECRET),
    teamPrice: stringEnv(runtime.STRIPE_PRICE_TEAM),
    enterprisePrice: stringEnv(runtime.STRIPE_PRICE_ENTERPRISE),
    meterEventName: stringEnv(runtime.STRIPE_METER_EVENT_NAME),
  };
  if (!config.secretKey || (requireWebhook && !config.webhookSecret)) throw new BillingError("Stripe 尚未配置完整的服务端密钥", 503);
  return config;
}

export function billingConfigured(): boolean {
  try { const config = configuration(); return Boolean(config.webhookSecret); } catch { return false; }
}

export async function getBillingAccount(organizationId: string): Promise<BillingAccount> {
  await ensureSchema();
  const row = await database().prepare(`SELECT * FROM billing_accounts WHERE organization_id=?`).bind(organizationId).first<D1Row>();
  if (row) return billingAccountFromRow(row);
  const now = new Date().toISOString();
  await database().prepare(`INSERT INTO billing_accounts (organization_id,provider,customer_id,subscription_id,status,plan,current_period_end,created_at,updated_at) VALUES (?,'stripe',NULL,NULL,'configuration-required','demo',NULL,?,?) ON CONFLICT(organization_id) DO NOTHING`).bind(organizationId, now, now).run();
  const created = await database().prepare(`SELECT * FROM billing_accounts WHERE organization_id=?`).bind(organizationId).first<D1Row>();
  if (!created) throw new BillingError("计费账户初始化失败", 500);
  return billingAccountFromRow(created);
}

export async function createCheckoutSession(input: { organizationId: string; plan: "team" | "enterprise"; email: string | null; origin: string }): Promise<{ url: string; sessionId: string }> {
  await ensureSchema();
  const config = configuration();
  const price = input.plan === "team" ? config.teamPrice : config.enterprisePrice;
  if (!price) throw new BillingError(`未配置 ${input.plan} 套餐的 Stripe Price`, 503);
  const account = await getBillingAccount(input.organizationId);
  const origin = normalizeOrigin(input.origin);
  const form = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    success_url: `${origin}/account?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/account?billing=cancelled`,
    client_reference_id: input.organizationId,
    "metadata[organization_id]": input.organizationId,
    "metadata[plan]": input.plan,
    "subscription_data[metadata][organization_id]": input.organizationId,
    "subscription_data[metadata][plan]": input.plan,
    allow_promotion_codes: "true",
    "automatic_tax[enabled]": "true",
  });
  if (account.customerId) form.set("customer", account.customerId);
  else if (input.email) form.set("customer_email", input.email);
  const session = await stripeRequest<{ id?: string; url?: string }>(config, "/v1/checkout/sessions", form, `checkout-${input.organizationId}-${input.plan}-${new Date().toISOString().slice(0, 13)}`);
  if (!session.id || !session.url) throw new BillingError("Stripe Checkout 没有返回访问链接", 502);
  const now = new Date().toISOString();
  await database().prepare(`UPDATE billing_accounts SET status='checkout-open',plan=?,updated_at=? WHERE organization_id=?`).bind(input.plan, now, input.organizationId).run();
  return { url: session.url, sessionId: session.id };
}

export async function createBillingPortalSession(organizationId: string, origin: string): Promise<{ url: string }> {
  const config = configuration();
  const account = await getBillingAccount(organizationId);
  if (!account.customerId) throw new BillingError("该组织还没有 Stripe Customer，请先开通套餐", 409);
  const session = await stripeRequest<{ url?: string }>(config, "/v1/billing_portal/sessions", new URLSearchParams({ customer: account.customerId, return_url: `${normalizeOrigin(origin)}/account` }));
  if (!session.url) throw new BillingError("Stripe Billing Portal 没有返回访问链接", 502);
  return { url: session.url };
}

export async function processStripeWebhook(rawBody: string, signature: string | null): Promise<{ received: true; duplicate: boolean }> {
  await ensureSchema();
  const config = configuration(true);
  if (!signature || !await verifyStripeWebhookSignature(rawBody, signature, config.webhookSecret!)) throw new BillingError("Stripe Webhook 签名无效", 400);
  const event = parseJson<{ id?: string; type?: string; data?: { object?: StripeObject } }>(rawBody, {});
  if (!event.id || !event.type || !event.data?.object) throw new BillingError("Stripe Webhook 载荷无效");
  const now = new Date().toISOString();
  const inserted = await database().prepare(`INSERT INTO billing_events (id,organization_id,provider_event_id,kind,status,payload_json,created_at,processed_at) VALUES (?,NULL,?,?,'processing',?,?,NULL) ON CONFLICT(provider_event_id) DO NOTHING`).bind(crypto.randomUUID(), event.id, event.type, boundedJson(rawBody), now).run();
  if (Number(inserted.meta.changes ?? 0) !== 1) return { received: true, duplicate: true };
  try {
    const object = event.data.object;
    const organizationId = object.metadata?.organization_id || (typeof object.client_reference_id === "string" ? object.client_reference_id : null);
    if (event.type === "checkout.session.completed" && organizationId) {
      const plan = object.metadata?.plan === "enterprise" ? "enterprise" : "team";
      await upsertBillingAccount(organizationId, { customerId: stringValue(object.customer), subscriptionId: stringValue(object.subscription), status: "active", plan, periodEnd: null });
    } else if (event.type.startsWith("customer.subscription.")) {
      const subscriptionId = stringValue(object.id);
      const customerId = stringValue(object.customer);
      const resolvedOrganizationId = organizationId ?? await findOrganizationForBillingObject(customerId, subscriptionId);
      if (resolvedOrganizationId) {
        const stripeStatus = event.type === "customer.subscription.deleted" ? "canceled" : normalizeStripeStatus(object.status);
        const plan = object.metadata?.plan === "enterprise" ? "enterprise" : object.metadata?.plan === "team" ? "team" : undefined;
        await upsertBillingAccount(resolvedOrganizationId, { customerId, subscriptionId, status: stripeStatus, plan, periodEnd: typeof object.current_period_end === "number" ? new Date(object.current_period_end * 1_000).toISOString() : null });
      }
    }
    await database().prepare(`UPDATE billing_events SET organization_id=?,status='processed',processed_at=? WHERE provider_event_id=?`).bind(organizationId, new Date().toISOString(), event.id).run();
    return { received: true, duplicate: false };
  } catch (error) {
    await database().prepare(`UPDATE billing_events SET status='failed',processed_at=? WHERE provider_event_id=?`).bind(new Date().toISOString(), event.id).run();
    throw error;
  }
}

export async function exportPendingMeterUsage(limit = 100): Promise<{ exported: number; failed: number; skipped: number }> {
  await ensureSchema();
  const config = configuration();
  if (!config.meterEventName) return { exported: 0, failed: 0, skipped: 1 };
  const rows = await database().prepare(`SELECT u.*,b.customer_id FROM usage_events u JOIN billing_accounts b ON b.organization_id=u.organization_id AND b.status IN ('active','trialing') WHERE u.kind IN ('model_tokens','database_write') AND b.customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM billing_events e WHERE e.provider_event_id='usage:'||u.id) ORDER BY u.created_at ASC LIMIT ?`).bind(Math.max(1, Math.min(500, limit))).all<D1Row>();
  let exported = 0;
  let failed = 0;
  for (const row of rows.results ?? []) {
    const usageId = String(row.id);
    const eventId = `usage:${usageId}`;
    try {
      await stripeRequest(config, "/v1/billing/meter_events", new URLSearchParams({
        event_name: config.meterEventName,
        "payload[stripe_customer_id]": String(row.customer_id),
        "payload[value]": String(Math.max(0, Number(row.quantity))),
        identifier: usageId,
        timestamp: String(Math.floor(Date.parse(String(row.created_at)) / 1_000)),
      }), eventId);
      await database().prepare(`INSERT INTO billing_events (id,organization_id,provider_event_id,kind,status,payload_json,created_at,processed_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(provider_event_id) DO NOTHING`).bind(crypto.randomUUID(), row.organization_id, eventId, "meter_event", "processed", JSON.stringify({ usageId, kind: row.kind, quantity: row.quantity }), new Date().toISOString(), new Date().toISOString()).run();
      exported += 1;
    } catch {
      failed += 1;
    }
  }
  return { exported, failed, skipped: 0 };
}

async function upsertBillingAccount(organizationId: string, input: { customerId: string | null; subscriptionId: string | null; status: BillingAccount["status"]; plan?: BillingAccount["plan"]; periodEnd: string | null }): Promise<void> {
  const now = new Date().toISOString();
  const resolvedPlan = input.plan ?? (await getBillingAccount(organizationId)).plan;
  await database().prepare(`INSERT INTO billing_accounts (organization_id,provider,customer_id,subscription_id,status,plan,current_period_end,created_at,updated_at) VALUES (?,'stripe',?,?,?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET customer_id=COALESCE(excluded.customer_id,billing_accounts.customer_id),subscription_id=COALESCE(excluded.subscription_id,billing_accounts.subscription_id),status=excluded.status,plan=excluded.plan,current_period_end=excluded.current_period_end,updated_at=excluded.updated_at`).bind(organizationId, input.customerId, input.subscriptionId, input.status, resolvedPlan, input.periodEnd, now, now).run();
  if (resolvedPlan === "team" || resolvedPlan === "enterprise") await database().prepare(`UPDATE organizations SET plan=?,updated_at=? WHERE id=?`).bind(resolvedPlan, now, organizationId).run();
}

async function findOrganizationForBillingObject(customerId: string | null, subscriptionId: string | null): Promise<string | null> {
  const row = await database().prepare(`SELECT organization_id FROM billing_accounts WHERE (? IS NOT NULL AND customer_id=?) OR (? IS NOT NULL AND subscription_id=?) LIMIT 1`).bind(customerId, customerId, subscriptionId, subscriptionId).first<D1Row>();
  return row?.organization_id ? String(row.organization_id) : null;
}

async function stripeRequest<T>(config: BillingConfig, path: string, form: URLSearchParams, idempotencyKey?: string): Promise<T> {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.secretKey}`, "Content-Type": "application/x-www-form-urlencoded", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey.slice(0, 255) } : {}) },
    body: form.toString(),
  });
  const data = await response.json().catch(() => ({})) as T & { error?: { message?: string } };
  if (!response.ok) throw new BillingError(data.error?.message || `Stripe 返回 ${response.status}`, response.status === 401 || response.status === 403 ? 503 : 502);
  return data;
}

function billingAccountFromRow(row: D1Row): BillingAccount {
  return {
    organizationId: String(row.organization_id), provider: "stripe", customerId: row.customer_id ? String(row.customer_id) : null,
    subscriptionId: row.subscription_id ? String(row.subscription_id) : null, status: String(row.status) as BillingAccount["status"], plan: String(row.plan) as BillingAccount["plan"],
    currentPeriodEnd: row.current_period_end ? String(row.current_period_end) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function normalizeStripeStatus(value: unknown): BillingAccount["status"] {
  const supported = new Set<BillingAccount["status"]>(["incomplete", "trialing", "active", "past_due", "unpaid", "paused", "canceled"]);
  return supported.has(value as BillingAccount["status"]) ? value as BillingAccount["status"] : "incomplete";
}

function boundedJson(value: string): string {
  return value.length <= 120_000 ? value : JSON.stringify({ truncated: true, bytes: value.length });
}

function normalizeOrigin(value: string): string {
  return new URL(value).origin;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function stringEnv(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
