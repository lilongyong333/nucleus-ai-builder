import { AppPlatformError, createAppRecord, listAppRecords, verifyAppSession } from "@/lib/app-platform-db";

export function OPTIONS() {
  return runtimeResponse(new Response(null, { status: 204 }));
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string; collection: string }> }) {
  try {
    const { projectId, collection } = await context.params;
    const session = await verifyAppSession(request, projectId);
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
    return runtimeResponse(Response.json({ records: await listAppRecords(projectId, session, collection, limit) }));
  } catch (error) {
    return runtimeError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string; collection: string }> }) {
  try {
    const { projectId, collection } = await context.params;
    const session = await verifyAppSession(request, projectId);
    const input = await request.json();
    return runtimeResponse(Response.json({ record: await createAppRecord(projectId, session, collection, input) }, { status: 201 }));
  } catch (error) {
    return runtimeError(error);
  }
}

function runtimeError(error: unknown): Response {
  const status = error instanceof AppPlatformError ? error.status : 500;
  return runtimeResponse(Response.json({ error: error instanceof Error ? error.message : "运行时数据操作失败" }, { status }));
}

function runtimeResponse(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return response;
}
