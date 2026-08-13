import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { AccountDashboard } from "@/components/account-dashboard";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await requireChatGPTUser("/account");
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return <AccountDashboard origin={`${protocol}://${host}`} user={{ displayName: user.displayName, email: user.email }} />;
}
