import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const target = normalizeTarget(process.env.NUCLEUS_LOAD_TARGET || process.argv[2] || "http://localhost:4173");
const requests = boundedInt(process.env.NUCLEUS_LOAD_REQUESTS, 200, 1, 20_000);
const concurrency = boundedInt(process.env.NUCLEUS_LOAD_CONCURRENCY, 10, 1, 200);
const timeoutMs = boundedInt(process.env.NUCLEUS_LOAD_TIMEOUT_MS, 12_000, 500, 60_000);
const paths = (process.env.NUCLEUS_LOAD_PATHS || "/,/api/session").split(",").map((value) => value.trim()).filter((value) => value.startsWith("/")).slice(0, 20);
const cookie = process.env.NUCLEUS_LOAD_COOKIE?.trim();

if (paths.length === 0) throw new Error("NUCLEUS_LOAD_PATHS must contain at least one absolute path");

let cursor = 0;
const samples = [];
const startedAt = performance.now();
await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async (_, worker) => {
  while (true) {
    const index = cursor++;
    if (index >= requests) return;
    const path = paths[index % paths.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("load-test timeout", "TimeoutError")), timeoutMs);
    const requestStartedAt = performance.now();
    try {
      const response = await fetch(new URL(path, target), { headers: { "User-Agent": `Nucleus-ReadOnly-Load-Test/1.0 worker-${worker}`, ...(cookie ? { Cookie: cookie } : {}) }, redirect: "manual", signal: controller.signal });
      await response.arrayBuffer();
      samples.push({ index, path, status: response.status, ok: response.status < 500, durationMs: performance.now() - requestStartedAt, error: null });
    } catch (error) {
      samples.push({ index, path, status: null, ok: false, durationMs: performance.now() - requestStartedAt, error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
    }
  }
}));

const durationMs = performance.now() - startedAt;
const latencies = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
const failures = samples.filter((sample) => !sample.ok);
const statusCounts = Object.fromEntries([...new Set(samples.map((sample) => String(sample.status ?? "network-error")))].map((status) => [status, samples.filter((sample) => String(sample.status ?? "network-error") === status).length]));
const report = {
  target,
  mode: "read-only",
  requests,
  concurrency,
  paths,
  durationMs: Math.round(durationMs),
  requestsPerSecond: Number((requests / Math.max(durationMs / 1_000, 0.001)).toFixed(2)),
  successful: requests - failures.length,
  failed: failures.length,
  failureRate: Number((failures.length / requests).toFixed(4)),
  latencyMs: { min: round(latencies[0]), p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99), max: round(latencies.at(-1)) },
  statusCounts,
  errors: failures.slice(0, 20).map(({ index, path, status, error }) => ({ index, path, status, error })),
  completedAt: new Date().toISOString(),
};

await mkdir("test-results/load", { recursive: true });
await writeFile("test-results/load/report.json", `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.failureRate > Number(process.env.NUCLEUS_LOAD_MAX_FAILURE_RATE ?? 0.01)) process.exitCode = 1;

function percentile(values, ratio) {
  if (values.length === 0) return null;
  return round(values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)]);
}

function round(value) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function normalizeTarget(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Load target must use HTTPS except localhost");
  return url.origin;
}
