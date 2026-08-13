import { describe, expect, it } from "vitest";
import { scoreFileCandidate } from "./race-score";

describe("Race Mode candidate scoring", () => {
  it("prefers semantic, accessible HTML without embedded scripts", () => {
    const weak = `<div>${"x".repeat(900)}</div><script>alert(1)</script>`;
    const strong = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><main id="app"><label for="name">Name</label><input id="name"><button data-action="save">Save</button>${"x".repeat(900)}</main></body></html>`;
    expect(scoreFileCandidate("index.html", strong)).toBeGreaterThan(scoreFileCandidate("index.html", weak));
  });

  it("rewards responsive and accessible CSS", () => {
    const weak = `.app{color:red}${" ".repeat(1300)}`;
    const strong = `:root{--space:12px}.app{width:min(100%,900px);padding:clamp(8px,2vw,24px)}button:focus-visible{outline:2px solid blue}@media(max-width:600px){.app{width:100%}}@media(prefers-reduced-motion:reduce){*{animation:none!important}}${" ".repeat(1300)}`;
    expect(scoreFileCandidate("styles.css", strong)).toBeGreaterThan(scoreFileCandidate("styles.css", weak));
  });

  it("rewards interactive JavaScript using the durable runtime API", () => {
    const weak = `console.log('hello');${" ".repeat(1300)}`;
    const strong = `async function render(){try{const rows=await window.nucleus.data.list('tasks');document.body.dataset.count=String(rows.length)}catch(error){console.error(error)}}document.addEventListener('keydown',render);document.addEventListener('pointerdown',render);${" ".repeat(1300)}`;
    expect(scoreFileCandidate("script.js", strong)).toBeGreaterThan(scoreFileCandidate("script.js", weak));
  });
});
