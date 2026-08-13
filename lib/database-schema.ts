import type { AppManifest } from "./types";
import { boundedExponentialDelayMs } from "./retry-policy";

/**
 * Stable revision of the application-owned database contract.
 *
 * AppManifest.schemaVersion versions the manifest envelope. This digest instead
 * changes only when collections or fields change, so the Provisioner can
 * reconcile schema drift without rebuilding a physical database for UI-only
 * edits.
 */
export async function databaseSchemaRevision(manifest: AppManifest): Promise<number> {
  const canonical = JSON.stringify(manifest.database.collections.map((collection) => ({
    name: collection.name,
    access: collection.access,
    fields: collection.fields.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required,
      defaultValue: field.default ?? null,
    })),
  })));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
}

export function provisioningRetryDelayMs(attemptCount: number): number {
  return boundedExponentialDelayMs(attemptCount, 30_000, 10);
}
