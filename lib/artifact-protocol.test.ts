import { describe, expect, it } from "vitest";
import { artifactProtocolViolation, canonicalFileResponsibilities, normalizeArtifactContent } from "./artifact-protocol";

describe("three-file artifact protocol", () => {
  it("keeps Bob's responsibilities immutable", () => {
    expect(canonicalFileResponsibilities["index.html"]).toContain("禁止内联");
    expect(canonicalFileResponsibilities["styles.css"]).toContain("独立 CSS");
    expect(canonicalFileResponsibilities["script.js"]).toContain("独立原生 JavaScript");
  });

  it("accepts complete isolated files", () => {
    expect(artifactProtocolViolation("index.html", "<!doctype html><html><head></head><body><main id='app'></main></body></html>")).toBeNull();
    expect(artifactProtocolViolation("styles.css", "main { color: red; } @media (max-width: 600px) { main { color: blue; } }")).toBeNull();
    expect(artifactProtocolViolation("script.js", "document.querySelector('#app')?.addEventListener('click', () => {});")).toBeNull();
  });

  it("rejects all-in-one HTML and markdown leakage", () => {
    expect(artifactProtocolViolation("index.html", "<!doctype html><html><body><style>body{}</style></body></html>")).toContain("三文件隔离");
    expect(artifactProtocolViolation("index.html", "```html{path=index.html}\n<html></html>\n```")).toContain("Markdown");
  });

  it("removes redundant local file references before enforcing isolation", () => {
    const normalized = normalizeArtifactContent("index.html", "<!doctype html><html><head><link rel='stylesheet' href='./styles.css'></head><body><main></main><script defer src='script.js'></script></body></html>");
    expect(normalized).not.toContain("styles.css");
    expect(normalized).not.toContain("script.js");
    expect(artifactProtocolViolation("index.html", normalized)).toBeNull();
  });

  it("rejects truncated CSS and JavaScript before checkpointing", () => {
    expect(artifactProtocolViolation("styles.css", "main { color: red;")).toContain("截断");
    expect(artifactProtocolViolation("script.js", "function start() {")).toContain("语法不完整");
  });
});
