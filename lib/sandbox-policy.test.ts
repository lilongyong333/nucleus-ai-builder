import { describe, expect, it } from "vitest";
import { buildAppManifest, defaultRuntimeBlueprint, normalizeRuntimeBlueprint } from "./app-manifest";
import { buildSandboxContract, SandboxPolicyError, signRunnerPayload, validateDependencies, validateGeneratedSource, verifyRunnerPayloadSignature } from "./sandbox-policy";
import { starterFiles } from "./runtime";
import type { AgentPlan, AppManifest } from "./types";

const plan: AgentPlan = { appName: "Security", summary: "security eval", features: ["保存数据"], design: "responsive" };

function manifestWith(dependencies: Partial<AppManifest["dependencies"]>): AppManifest {
  const blueprint = defaultRuntimeBlueprint("保存数据", plan);
  const manifest = buildAppManifest({ projectId: "security-project", versionId: "v1", plan, blueprint });
  manifest.dependencies = { ...manifest.dependencies, ...dependencies };
  return manifest;
}

describe("sandbox dependency and escape policy", () => {
  it.each([
    ["npm remote tarball", { npm: ["https://evil.invalid/pkg.tgz"] }, "dependency.npm-registry-only"],
    ["npm lifecycle flag", { npm: ["react --ignore-scripts=false"] }, "dependency.npm-registry-only"],
    ["npm git source", { npm: ["git+ssh://git@evil.invalid/pkg"] }, "dependency.npm-registry-only"],
    ["npm local file", { npm: ["file:../poisoned-package"] }, "dependency.npm-registry-only"],
    ["npm workspace escape", { npm: ["workspace:*"] }, "dependency.npm-registry-only"],
    ["pip remote wheel", { pip: ["https://evil.invalid/pkg.whl"] }, "dependency.pypi-only"],
    ["pip extra index", { pip: ["requests --extra-index-url https://evil.invalid/simple"] }, "dependency.pypi-only"],
    ["system shell injection", { system: ["curl;sh payload"] }, "dependency.system-allowlist"],
    ["mutable container tag", { containers: ["docker.io/library/node:latest"] }, "container.digest-required"],
    ["untrusted registry", { containers: [`evil.invalid/x@y${""}`.replace("@y", "@sha256:") + "a".repeat(64)] }, "container.registry-allowlist"],
  ])("rejects %s", (_label, dependencies, rule) => {
    const manifest = manifestWith(dependencies as Partial<AppManifest["dependencies"]>);
    expect(() => validateDependencies(manifest, ["docker.io"])).toThrowError(SandboxPolicyError);
    try { validateDependencies(manifest, ["docker.io"]); } catch (error) { expect((error as SandboxPolicyError).rule).toBe(rule); }
  });

  it("produces an immutable gVisor/Kata execution contract for registry-only dependencies", async () => {
    const digest = "a".repeat(64);
    const manifest = manifestWith({ npm: ["react@19.2.6", "@scope/pkg@^1.2.3"], pip: ["fastapi==0.120.0"], system: ["ffmpeg"], containers: [`docker.io/library/node@sha256:${digest}`] });
    const contract = await buildSandboxContract(starterFiles, manifest, ["docker.io"]);
    expect(contract.filesSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(contract.isolation).toMatchObject({ runtime: "gvisor-or-kata-required", rootFilesystem: "read-only", capabilities: "drop-all", network: "deny-by-default", privilegeEscalation: false });
    expect(contract.dependencyPolicy.npmIgnoreScripts).toBe(true);
  });

  it("drops reserved physical-database columns from model-authored schemas", () => {
    const blueprint = normalizeRuntimeBlueprint({ collections: [{ name: "notes", access: "owner", fields: [
      { name: "id", type: "string", required: true },
      { name: "owner_subject", type: "string", required: true },
      { name: "title", type: "string", required: true },
    ] }] }, "notes", plan);
    expect(blueprint.collections[0].fields.map((field) => field.name)).toEqual(["title"]);
  });

  it("authenticates callback bytes and rejects tampering, staleness, and malformed headers", async () => {
    const body = JSON.stringify({ jobId: "job-1", status: "passed", result: { ok: true } });
    const secret = "runner-secret-with-enough-entropy";
    const now = 1_786_315_200_000;
    const timestamp = String(Math.floor(now / 1_000));
    const signature = await signRunnerPayload(body, secret, timestamp);
    expect(await verifyRunnerPayloadSignature(body, secret, timestamp, `v1=${signature}`, now)).toBe(true);
    expect(await verifyRunnerPayloadSignature(`${body} `, secret, timestamp, `v1=${signature}`, now)).toBe(false);
    expect(await verifyRunnerPayloadSignature(body, secret, String(Number(timestamp) - 301), `v1=${signature}`, now)).toBe(false);
    expect(await verifyRunnerPayloadSignature(body, secret, timestamp, signature, now)).toBe(false);
  });

  it.each([
    ["metadata SSRF", "fetch('http://169.254.169.254/latest/meta-data')", "source.metadata-service"],
    ["docker socket escape", "const socket='/var/run/docker.sock'", "source.container-socket"],
    ["process spawn", "import { exec } from 'node:child_process'", "source.process-spawn"],
    ["file URI", "fetch('file:///etc/passwd')", "source.file-uri"],
  ])("rejects generated-source %s", (_label, script, expectedRule) => {
    expect(() => validateGeneratedSource({ ...starterFiles, "script.js": script })).toThrowError(SandboxPolicyError);
    try { validateGeneratedSource({ ...starterFiles, "script.js": script }); } catch (error) { expect((error as SandboxPolicyError).rule).toBe(expectedRule); }
  });
});
