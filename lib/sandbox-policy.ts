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

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
