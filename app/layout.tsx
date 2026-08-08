import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  return {
    title: "Nucleus — 想法即应用",
    description: "描述一个想法，AI 智能体团队为你规划、构建并交付可运行的网页应用。",
    openGraph: { title: "Nucleus — 想法即应用", description: "让一支 AI 团队把想法变成真正可运行的网页应用。", images: [{ url: image, width: 1672, height: 941 }] },
    twitter: { card: "summary_large_image", title: "Nucleus — 想法即应用", description: "让一支 AI 团队把想法变成真正可运行的网页应用。", images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
