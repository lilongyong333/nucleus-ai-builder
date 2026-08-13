const MAX_KEYS = 200;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_LENGTH = 50_000;
const MAX_TOTAL_LENGTH = 1_000_000;
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function validKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_KEY_LENGTH && !BLOCKED_KEYS.has(key);
}

export type PreviewStorageMutation = {
  action?: unknown;
  key?: unknown;
  value?: unknown;
};

export function parsePreviewStorage(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter(([key, value]) => validKey(key) && typeof value === "string" && value.length <= MAX_VALUE_LENGTH)
      .slice(0, MAX_KEYS);
    const result: Record<string, string> = {};
    let total = 0;
    for (const [key, value] of entries) {
      if (total + key.length + (value as string).length > MAX_TOTAL_LENGTH) break;
      result[key] = value as string;
      total += key.length + (value as string).length;
    }
    return result;
  } catch {
    return {};
  }
}

export function applyPreviewStorageMutation(current: Record<string, string>, mutation: PreviewStorageMutation): Record<string, string> {
  if (mutation.action === "clear") return {};
  if (mutation.action !== "set" && mutation.action !== "remove") return current;
  if (typeof mutation.key !== "string" || !validKey(mutation.key)) return current;
  const next = { ...current };
  if (mutation.action === "remove") {
    delete next[mutation.key];
    return next;
  }
  if (typeof mutation.value !== "string" || mutation.value.length > MAX_VALUE_LENGTH) return current;
  if (!(mutation.key in next) && Object.keys(next).length >= MAX_KEYS) return current;
  next[mutation.key] = mutation.value;
  const total = Object.entries(next).reduce((sum, [key, value]) => sum + key.length + value.length, 0);
  return total <= MAX_TOTAL_LENGTH ? next : current;
}
