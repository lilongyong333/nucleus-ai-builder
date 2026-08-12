import type { AppManifest, GeneratedFiles } from "./types";

export class SandboxPolicyError extends Error {
  constructor(message: string, readonly rule: string) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@(?:\^|~|>=?|<=?)?[a-z0-9][a-z0-9.+_-]*)?$/i;
const PIP_PACKAGE = /^[a-z0-9][a-z0-9._-]*(?:\[[a-z0-9,._-]+\])?(?:(?:==|~=|>=|<=|>|<)[a-z0-9][a-z0-9.*+!_-]*)?$/i;
const SYSTEM_PACKAGE = /^[a-z0-9][a-z0-9+._-]{0,79}$/i;
const FORBIDDEN_SOURCE = /(?:https?:|git\+|git@|github:|file:|workspace:|link:|\.\.|\\|--|\s)/i;

export type SandboxContract = {
  policyVersion: 1;
  executionId: string;
  filesSha256: string;
  dependencyPolicy: {
    npmIgnoreScripts: true;
    pipNoBinary: boolean;
    immutableSystemImage: true;
    containerImages: string[];
  };
  isolation: {
    runtime: "gvisor-or-kata-required";
    rootFilesystem: "read-only";
    uid: 65532;
    capabilities: "drop-all";
    privilegeEscalation: false;
    seccomp: "runtime-default";
    network: "deny-by-default";
    maxCpuSeconds: number;
    maxMemoryMb: number;
    maxDiskMb: number;
    maxPids: number;
  };
};

export async function buildSandboxContract(files: GeneratedFiles, manifest: AppManifest, allowedContainerRegistries: string[]): Promise<SandboxContract> {
  validateDependencies(manifest, allowedContainerRegistries);
  validateGeneratedSource(files);
  const serializedFiles = JSON.stringify(files);
  if (serializedFiles.length > 1_500_000) throw new SandboxPolicyError("生成工件超过沙箱传输上限", "artifact.max-bytes");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serializedFiles)));
  return {
    policyVersion: 1,
    executionId: crypto.randomUUID(),
    filesSha256: hex(digest),
    dependencyPolicy: { npmIgnoreScripts: true, pipNoBinary: false, immutableSystemImage: true, containerImages: manifest.dependencies.containers },
    isolation: {
      runtime: "gvisor-or-kata-required",
      rootFilesystem: "read-only",
      uid: 65532,
      capabilities: "drop-all",
      privilegeEscalation: false,
      seccomp: "runtime-default",
      network: "deny-by-default",
      maxCpuSeconds: 120,
      maxMemoryMb: 1024,
      maxDiskMb: 2048,
      maxPids: 128,
    },
  };
}

export function validateGeneratedSource(files: GeneratedFiles): void {
  const rules: Array<{ pattern: RegExp; rule: string; message: string }> = [
    { pattern: /(?:169\.254\.169\.254|metadata\.google\.internal)/i, rule: "source.metadata-service", message: "禁止访问云实例元数据服务" },
    { pattern: /(?:\/var\/run\/docker\.sock|\\\\\.\\pipe\\docker_engine)/i, rule: "source.container-socket", message: "禁止访问宿主容器运行时 Socket" },
    { pattern: /(?:node:)?child_process|\brequire\s*\(\s*["']child_process["']\s*\)|\b(?:Deno\.run|Bun\.spawn|process\.binding)\b/i, rule: "source.process-spawn", message: "生成代码禁止启动宿主进程" },
    { pattern: /\bfile:\/\//i, rule: "source.file-uri", message: "生成代码禁止通过 file URI 读取宿主文件" },
  ];
  for (const [path, content] of Object.entries(files)) {
    for (const rule of rules) {
      if (rule.pattern.test(content)) throw new SandboxPolicyError(`${rule.message}：${path}`, rule.rule);
    }
  }
}

export function validateDependencies(manifest: AppManifest, allowedContainerRegistries: string[]): void {
  for (const dependency of manifest.dependencies.npm) {
    if (FORBIDDEN_SOURCE.test(dependency) || !NPM_PACKAGE.test(dependency)) throw new SandboxPolicyError(`npm 依赖来源被策略拒绝：${dependency}`, "dependency.npm-registry-only");
  }
  for (const dependency of manifest.dependencies.pip) {
    if (FORBIDDEN_SOURCE.test(dependency) || !PIP_PACKAGE.test(dependency)) throw new SandboxPolicyError(`pip 依赖来源被策略拒绝：${dependency}`, "dependency.pypi-only");
  }
  for (const dependency of manifest.dependencies.system) {
    if (!SYSTEM_PACKAGE.test(dependency)) throw new SandboxPolicyError(`系统依赖名称被策略拒绝：${dependency}`, "dependency.system-allowlist");
  }
  for (const image of manifest.dependencies.containers) {
    if (!/^[a-z0-9][a-z0-9._:/-]+(?:@sha256:[a-f0-9]{64})$/i.test(image)) throw new SandboxPolicyError(`容器镜像必须固定 sha256 digest：${image}`, "container.digest-required");
    const registry = image.split("/")[0].toLowerCase();
    if (!allowedContainerRegistries.map((item) => item.toLowerCase()).includes(registry)) throw new SandboxPolicyError(`容器 Registry 不在允许清单：${registry}`, "container.registry-allowlist");
  }
}

export async function signRunnerPayload(payload: string, secret: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)));
  return hex(digest);
}

export async function verifyRunnerPayloadSignature(payload: string, secret: string, timestamp: string | null, suppliedSignature: string | null, nowMs = Date.now()): Promise<boolean> {
  if (!secret || !timestamp || !suppliedSignature || !/^\d{10,13}$/.test(timestamp)) return false;
  const timestampSeconds = Number(timestamp.length === 13 ? Math.floor(Number(timestamp) / 1_000) : timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Math.floor(nowMs / 1_000) - timestampSeconds) > 300) return false;
  const supplied = suppliedSignature.match(/^v1=([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
  if (!supplied) return false;
  const expected = await signRunnerPayload(payload, secret, timestamp);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  return difference === 0;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
