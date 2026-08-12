import { describe, expect, it } from "vitest";
import { addUsage, emptyUsage, normalizeUsage } from "./usage";

describe("model usage accounting", () => {
  it("normalizes OpenAI-compatible usage", () => {
    expect(normalizeUsage({ prompt_tokens: 120.9, completion_tokens: 30, total_tokens: 151 })).toEqual({ promptTokens: 120, completionTokens: 30, totalTokens: 151 });
  });

  it("derives a total and ignores malformed counts", () => {
    expect(normalizeUsage({ prompt_tokens: 12, completion_tokens: 8, total_tokens: -1 })).toEqual({ promptTokens: 12, completionTokens: 8, totalTokens: 20 });
  });

  it("normalizes Responses API input/output usage", () => {
    expect(normalizeUsage({ input_tokens: 40, output_tokens: 12, total_tokens: 52 })).toEqual({ promptTokens: 40, completionTokens: 12, totalTokens: 52 });
  });

  it("aggregates multiple model calls", () => {
    expect(addUsage(emptyUsage(), { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, { promptTokens: 3, completionTokens: 2, totalTokens: 5 })).toEqual({ promptTokens: 13, completionTokens: 7, totalTokens: 20 });
  });
});
