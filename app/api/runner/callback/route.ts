import { acceptRunnerCallback, RunnerProviderError } from "@/lib/runner-provider";

export async function POST(request: Request) {
  try {
    return Response.json({ job: await acceptRunnerCallback(request) });
  } catch (error) {
    const status = error instanceof RunnerProviderError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : "Runner callback 失败" }, { status });
  }
}
