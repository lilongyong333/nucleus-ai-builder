import { describe, expect, it } from "vitest";
import { qualityRepairBrief, reviewGeneratedApp } from "./quality";
import { starterFiles } from "./runtime";

describe("generated app quality gate", () => {
  it("accepts a complete interactive responsive app", () => {
    const report = reviewGeneratedApp(starterFiles);
    expect(report.passed).toBe(true);
    expect(report.score).toBeGreaterThanOrEqual(90);
    expect(report.grade).toBe("A");
  });

  it("blocks JavaScript syntax errors", () => {
    const report = reviewGeneratedApp({ ...starterFiles, "script.js": "const broken = ;" });
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.id === "javascript-syntax")?.severity).toBe("error");
    expect(qualityRepairBrief(report)).toContain("语法错误");
  });

  it("blocks static mockups without real interaction", () => {
    const report = reviewGeneratedApp({
      "index.html": '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><main><h1>Only a mockup</h1></main></body></html>',
      "styles.css": "main{max-width:40rem;margin:auto}@media(max-width:600px){main{padding:1rem}}",
      "script.js": "document.body.dataset.ready = 'true';",
    });
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.id === "real-interaction")?.severity).toBe("error");
  });

  it("blocks dynamic code execution primitives", () => {
    const report = reviewGeneratedApp({ ...starterFiles, "script.js": "eval('alert(1)')" });
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.id === "runtime-safety")?.severity).toBe("error");
  });

  it("does not flag dangerous words inside ordinary text", () => {
    const report = reviewGeneratedApp({ ...starterFiles, "script.js": `${starterFiles["script.js"]}\nconst help = "Never use eval() in this app";` });
    expect(report.checks.find((check) => check.id === "runtime-safety")?.severity).toBe("pass");
  });
});
