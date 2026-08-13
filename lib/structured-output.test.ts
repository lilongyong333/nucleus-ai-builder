import { describe, expect, it } from "vitest";
import { isCompleteJsonArtifact, isCompleteSingleFileArtifact, parseStructuredJsonObject } from "./structured-output";

describe("structured model output recovery", () => {
  it("extracts the largest balanced JSON object from provider noise", () => {
    expect(parseStructuredJsonObject('thinking...\n```json\n{"summary":"ok","runtime":{"collections":[]}}\n```\nignored')).toEqual({
      summary: "ok",
      runtime: { collections: [] },
    });
  });

  it("repairs only harmless trailing JSON commas", () => {
    expect(parseStructuredJsonObject('{"summary":"ok","items":["a",],}')).toEqual({ summary: "ok", items: ["a"] });
  });

  it("refuses a truncated JSON object", () => {
    expect(isCompleteJsonArtifact('{"summary":"unfinished"')).toBe(false);
  });

  it("accepts only one complete protocol-valid file", () => {
    expect(isCompleteSingleFileArtifact("index.html", "```html{path=index.html}\n<!doctype html><html><body><main>OK</main></body></html>\n```")).toBe(true);
    expect(isCompleteSingleFileArtifact("index.html", "```html{path=index.html}\n<!doctype html><style>bad</style>\n```")).toBe(false);
  });
});
