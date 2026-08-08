import { describe, expect, it } from "vitest";
import { extractGeneratedFiles, parseGeneratedReply } from "./parser";
import { starterFiles } from "./runtime";

describe("model reply parser", () => {
  it("extracts path-labelled files without relying on JSON escaping", () => {
    const reply = `<summary>完成一个测试应用</summary>\n\`\`\`html{path=index.html}\n<main>OK</main>\n\`\`\`\n\`\`\`css{path=styles.css}\nmain{color:red}\n\`\`\`\n\`\`\`js{path=script.js}\ndocument.body.dataset.ready='1'\n\`\`\``;
    const parsed = parseGeneratedReply(reply, "fallback");
    expect(parsed.summary).toBe("完成一个测试应用");
    expect(parsed.files["index.html"]).toContain("OK");
    expect(parsed.files["styles.css"]).toContain("color:red");
  });

  it("keeps unchanged files during an incremental edit", () => {
    const reply = `\`\`\`js{path=script.js}\nconsole.log('updated')\n\`\`\``;
    const parsed = parseGeneratedReply(reply, "updated", starterFiles);
    expect(parsed.files["index.html"]).toBe(starterFiles["index.html"]);
    expect(parsed.files["script.js"]).toContain("updated");
  });

  it("reports which files were actually returned", () => {
    const reply = `\`\`\`html{path=index.html}\n<main>Only HTML</main>\n\`\`\``;
    const partial = extractGeneratedFiles(reply);
    expect(Object.keys(partial)).toEqual(["index.html"]);
  });
});
