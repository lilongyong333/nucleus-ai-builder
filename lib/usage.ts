import type { ModelUsage } from "./types";

export const emptyUsage = (): ModelUsage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function normalizeUsage(value: unknown): ModelUsage {
  const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const promptTokens = tokenCount(usage.prompt_tokens);
  const completionTokens = tokenCount(usage.completion_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: tokenCount(usage.total_tokens) || promptTokens + completionTokens,
  };
}

export function addUsage(...values: ModelUsage[]): ModelUsage {
  return values.reduce<ModelUsage>((total, usage) => ({
    promptTokens: total.promptTokens + usage.promptTokens,
    completionTokens: total.completionTokens + usage.completionTokens,
    totalTokens: total.totalTokens + usage.totalTokens,
  }), emptyUsage());
}
