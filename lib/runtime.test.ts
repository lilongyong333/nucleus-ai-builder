import { describe, expect, it } from "vitest";
import { composePreview, normalizeGeneratedFiles, starterFiles } from "./runtime";

describe("preview runtime", () => {
  it("assembles all three files into a sandbox document", () => {
    const html = composePreview(starterFiles);
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
    expect(html).toContain("__nucleus_probe__");
    expect(html).toContain("type:'ready'");
    expect(html).toContain("if(!window.__nucleusRuntimeFailed){parent.postMessage");
    expect(html).toContain("queueEvent('info','应用启动完成',{ready:true");
    expect(html).toContain("type:'console'");
    expect(html).toContain("['log','info','warn','error']");
    expect(html).toContain("emitted<200");
    expect(html).toContain("task-form");
  });

  it("neutralizes closing script tags inside generated JavaScript", () => {
    const html = composePreview({ ...starterFiles, "script.js": `console.log("</script>")` });
    expect(html).toContain("<\\/script>");
  });

  it("preserves dollar-based selector helpers when composing the final document", () => {
    const source = "const $ = (s) => document.querySelector(s); const $$ = (s) => document.querySelectorAll(s); const marker = '$&';";
    const html = composePreview({ ...starterFiles, "script.js": source });
    expect(html).toContain("const $ = (s)");
    expect(html).toContain("const $$ = (s)");
    expect(html).toContain("const marker = '$&'");
  });

  it("rejects incomplete model output", () => {
    expect(() => normalizeGeneratedFiles({ "index.html": "<main />" })).toThrow("styles.css");
  });

  it("injects the authenticated per-app data SDK and visual element picker", () => {
    const html = composePreview(starterFiles, {
      projectId: "project-123",
      versionId: "version-456",
      token: "runtime-token",
      actor: { id: "actor-1", type: "account", role: "editor", displayName: "Editor" },
    });
    expect(html).toContain('/api/app-runtime/project-123');
    expect(html).toContain("Authorization':'Bearer '");
    expect(html).toContain("window.nucleus={");
    expect(html).toContain("create:async function(collection,value)");
    expect(html).toContain("type:'element-selected'");
    expect(html).toContain("data.type==='visual-patch'");
    expect(html).toContain("data-nucleus-overlay");
  });
});
