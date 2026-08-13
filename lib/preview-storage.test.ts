import { describe, expect, it } from "vitest";
import { applyPreviewStorageMutation, parsePreviewStorage } from "./preview-storage";

describe("preview storage bridge", () => {
  it("parses and applies bounded storage mutations", () => {
    const parsed = parsePreviewStorage(JSON.stringify({ tasks: "[]", count: "1" }));
    const set = applyPreviewStorageMutation(parsed, { action: "set", key: "tasks", value: '[{"id":1}]' });
    const removed = applyPreviewStorageMutation(set, { action: "remove", key: "count" });
    expect(removed).toEqual({ tasks: '[{"id":1}]' });
    expect(applyPreviewStorageMutation(removed, { action: "clear" })).toEqual({});
  });

  it("rejects malformed or oversized input", () => {
    expect(parsePreviewStorage("not-json")).toEqual({});
    expect(applyPreviewStorageMutation({}, { action: "set", key: "x", value: "a".repeat(50_001) })).toEqual({});
    expect(applyPreviewStorageMutation({}, { action: "set", key: "__proto__", value: "blocked" })).toEqual({});
  });
});
