import { BillingError, processStripeWebhook } from "@/lib/billing";

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const result = await processStripeWebhook(rawBody, request.headers.get("stripe-signature"));
    return Response.json(result);
  } catch (error) {
    const status = error instanceof BillingError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : "Stripe Webhook 处理失败" }, { status });
  }
}
