import type { BillingAccount } from "./types";

export function entitledPlanForStatus(status: BillingAccount["status"], requestedPlan: BillingAccount["plan"]): BillingAccount["plan"] {
  return status === "active" || status === "trialing" || status === "past_due" ? requestedPlan : "demo";
}
