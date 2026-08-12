import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const target = normalizeTarget(process.env.NUCLEUS_LOAD_TARGET || process.argv[2] || "http://localhost:4173");
const requests = boundedInt(process.env.NUCLEUS_LOAD_REQUESTS, 200, 1, 20_000);
const concurrency = boundedInt(process.env.NUCLEUS_LOAD_CONCURRENCY, 10, 1, 200);
const timeoutMs = boundedInt(process.env.NUCLEUS_LOAD_TIMEOUT_MS, 12_000, 500, 60_000);
const allowWrites = process.env.NUCLEUS_LOAD_ALLOW_WRITES?.trim().toLowerCase() === "true";
const scenarios = await loadScenarios();
const users = await loadUsers();

if (scenarios.length === 0) throw new Error("Load test requires at least one scenario");
if (!allowWrites && scenarios.some((scenario) => !["GET", "HEAD", "OPTIONS"].includes(scenario.method))) throw new Error("Write scenarios require NUCLEUS_LOAD_ALLOW_WRITES=true");

let cursor = 0;
const samples = [];
const startedAt = performance.now();
await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async (_, worker) => {
  while (true) {
    const index = cursor++;
    if (index >= requests) return;
    const scenario = scenarios[index % scenarios.length];
    const user = users[index % users.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("load-test timeout", "TimeoutError")), timeoutMs);
    const requestStartedAt = performance.now();
    try {
      const response = await fetch(new URL(scenario.path, target), {
        method: scenario.method,
        headers: {
          "User-Agent": `Nucleus-MultiUser-Load-Test/2.0 worker-${worker}`,
          ...(user.cookie ? { Cookie: user.cookie } : {}),
          ...(scenario.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...scenario.headers,
        },
        body: scenario.body === undefined ? undefined : JSON.stringify(scenario.body),
        redirect: "manual",
        signal: controller.signal,
      });
      await response.arrayBuffer();
      const accepted = scenario.expectedStatuses.includes(response.status);
      samples.push({ index, scenario: scenario.name, user: user.name, status: response.status, ok: accepted, durationMs: performance.now() - requestStartedAt, error: accepted ? null : `unexpected status ${response.status}` });
    } catch (error) {
      samples.push({ index, scenario: scenario.name, user: user.name, status: null, ok: false, durationMs: performance.now() - requestStartedAt, error: error instanceof Error ? error.message : String(error) });
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
  mode: allowWrites ? "explicit-write-scenarios" : "read-only",
  requests,
  concurrency,
  virtualUsers: users.length,
  scenarios: scenarios.map(({ name, method, path, expectedStatuses }) => ({ name, method, path, expectedStatuses })),
  durationMs: Math.round(durationMs),
  requestsPerSecond: Number((requests / Math.max(durationMs / 1_000, 0.001)).toFixed(2)),
  successful: requests - failures.length,
  failed: failures.length,
  failureRate: Number((failures.length / requests).toFixed(4)),
  latencyMs: { min: round(latencies[0]), p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99), max: round(latencies.at(-1)) },
  statusCounts,
  errors: failures.slice(0, 20).map(({ index, scenario, user, status, error }) => ({ index, scenario, user, status, error })),
  completedAt: new Date().toISOString(),
};

await mkdir("test-results/load", { recursive: true });
await writeFile("test-results/load/report.json", `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
const maxFailureRate = Number(process.env.NUCLEUS_LOAD_MAX_FAILURE_RATE ?? 0.01);
const maxP95Ms = Number(process.env.NUCLEUS_LOAD_MAX_P95_MS ?? 2_500);
if (report.failureRate > maxFailureRate || (report.latencyMs.p95 !== null && report.latencyMs.p95 > maxP95Ms)) process.exitCode = 1;

async function loadScenarios() {
  const file = process.env.NUCLEUS_LOAD_SCENARIOS_FILE?.trim();
  if (file) {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("NUCLEUS_LOAD_SCENARIOS_FILE must contain a JSON array");
    return parsed.slice(0, 100).map((value, index) => normalizeScenario(value, index));
  }
  const paths = (process.env.NUCLEUS_LOAD_PATHS || "/,/api/session").split(",").map((value) => value.trim()).filter(Boolean).slice(0, 20);
  return paths.map((path, index) => normalizeScenario({ name: `read-${index + 1}`, method: "GET", path, expectedStatuses: [200, 204, 302, 303, 307, 308, 401, 403] }, index));
}

async function loadUsers() {
  const file = process.env.NUCLEUS_LOAD_USERS_FILE?.trim();
  if (file) {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("NUCLEUS_LOAD_USERS_FILE must contain a non-empty JSON array");
    return parsed.slice(0, 1_000).map((value, index) => ({ name: safeName(value?.name, `user-${index + 1}`), cookie: typeof value?.cookie === "string" ? value.cookie.trim() : "" }));
  }
  return [{ name: "anonymous", cookie: process.env.NUCLEUS_LOAD_COOKIE?.trim() || "" }];
}

function normalizeScenario(value, index) {
  if (!value || typeof value !== "object") throw new Error(`Scenario ${index + 1} must be an object`);
  const path = typeof value.path === "string" ? value.path.trim() : "";
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`Scenario ${index + 1} path must be relative and start with /`);
  const method = typeof value.method === "string" ? value.method.trim().toUpperCase() : "GET";
  if (!["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error(`Scenario ${index + 1} method is unsupported`);
  const expectedStatuses = Array.isArray(value.expectedStatuses) ? value.expectedStatuses.map(Number).filter((status) => Number.isInteger(status) && status >= 100 && status <= 599) : [200];
  if (expectedStatuses.length === 0) throw new Error(`Scenario ${index + 1} needs expectedStatuses`);
  const headers = value.headers && typeof value.headers === "object" && !Array.isArray(value.headers) ? Object.fromEntries(Object.entries(value.headers).filter(([key, headerValue]) => /^[a-z0-9-]{1,64}$/i.test(key) && typeof headerValue === "string" && !/[\r\n]/.test(headerValue))) : {};
  return { name: safeName(value.name, `scenario-${index + 1}`), method, path, body: value.body, headers, expectedStatuses };
}

function safeName(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : fallback;
}

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
