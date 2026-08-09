import { AppPlatformError, recordRuntimeEvidence, verifyAppSession } from "@/lib/app-platform-db";

export function OPTIONS() {
  return noStore(new Response(null, { status: 204 }));
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    const session = await verifyAppSession(request, projectId);
    const body = await request.json() as {
      versionId?: string;
      source?: "preview" | "published" | "browser-runner" | "api";
      events?: Array<{ level?: "info" | "warn" | "error"; message?: string; evidence?: Record<string, unknown> }>;
    };
    const events = Array.isArray(body.events) ? body.events.slice(0, 30) : [];
    const saved = [];
    for (const event of events) {
      if (typeof event.message !== "string" || !event.message.trim()) continue;
      saved.push(await recordRuntimeEvidence({
        projectId,
        versionId: typeof body.versionId === "string" ? body.versionId : null,
        sessionId: session.id,
        source: body.source === "published" || body.source === "browser-runner" || body.source === "api" ? body.source : "preview",
        level: event.level === "error" || event.level === "warn" ? event.level : "info",
        message: event.message,
        evidence: event.evidence,
      }));
    }
    return noStore(Response.json({ accepted: saved.length }, { status: 202 }));
  } catch (error) {
    const status = error instanceof AppPlatformError ? error.status : 500;
    return noStore(Response.json({ error: error instanceof Error ? error.message : "记录运行日志失败" }, { status }));
  }
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return response;
}
