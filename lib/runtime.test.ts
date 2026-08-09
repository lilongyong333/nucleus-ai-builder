import { describe, expect, it } from "vitest";
import { composePreview, normalizeGeneratedFiles, starterFiles } from "./runtime";

describe("preview runtime", () => {
  it("assembles all three files into a sandbox document", () => {
    const html = composePreview(starterFiles);
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
    expect(html).toContain("__nucleus_probe__");
    expect(html).toContain("type:'ready'");
    expect(html).toContain("type:'console'");
    expect(html).toContain("['log','info','warn','error']");
    expect(html).toContain("emitted<200");
    expect(html).toContain("task-form");
  });

  it("neutralizes closing script tags inside generated JavaScript", () => {
    const html = composePreview({ ...starterFiles, "script.js": `console.log("</script>")` });
    expect(html).toContain("<\\/script>");
  });

  it("rejects incomplete model output", () => {
    expect(() => normalizeGeneratedFiles({ "index.html": "<main />" })).toThrow("styles.css");
  });
});
