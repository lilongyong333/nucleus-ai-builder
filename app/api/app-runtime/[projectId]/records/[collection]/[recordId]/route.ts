import { AppPlatformError, deleteAppRecord, updateAppRecord, verifyAppSession } from "@/lib/app-platform-db";

export function OPTIONS() {
  return runtimeResponse(new Response(null, { status: 204 }));
}

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; collection: string; recordId: string }> }) {
  try {
    const { projectId, collection, recordId } = await context.params;
    const session = await verifyAppSession(request, projectId);
    const input = await request.json();
    return runtimeResponse(Response.json({ record: await updateAppRecord(projectId, session, collection, recordId, input) }));
  } catch (error) {
    return runtimeError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ projectId: string; collection: string; recordId: string }> }) {
  try {
    const { projectId, collection, recordId } = await context.params;
    const session = await verifyAppSession(request, projectId);
    await deleteAppRecord(projectId, session, collection, recordId);
    return runtimeResponse(new Response(null, { status: 204 }));
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
  response.headers.set("Access-Control-Allow-Methods", "PATCH, DELETE, OPTIONS");
  return response;
}
