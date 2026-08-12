import { describe, expect, it } from "vitest";
import { qualityRepairBrief, reviewGeneratedApp, reviewProductContract } from "./quality";
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

  it("blocks a fake snake mockup without a real game loop", () => {
    const checks = reviewProductContract("请设计一个贪吃蛇游戏", {
      ...starterFiles,
      "script.js": "document.querySelector('button').addEventListener('click', () => {});",
    });
    expect(checks).toHaveLength(5);
    expect(checks.some((check) => check.severity === "error")).toBe(true);
    expect(checks.find((check) => check.id === "snake-runtime-loop")?.severity).toBe("error");
  });

  it("recognizes evidence for a playable snake lifecycle", () => {
    const checks = reviewProductContract("Build a responsive Snake game", {
      "index.html": '<main><canvas id="game"></canvas><button id="restart">Restart</button></main>',
      "styles.css": "canvas{display:grid;grid-template-columns:repeat(20,1fr)}",
      "script.js": `
        const ctx = document.querySelector('canvas').getContext('2d');
        let snake = [], food = {}, score = 0, isPaused = false;
        function gameOver() { resetGame(); }
        function resetGame() { score = 0; ctx.fillRect(0, 0, 10, 10); }
        document.addEventListener('keydown', (event) => {
          if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) snake.push(event.key);
        });
        setInterval(() => { ctx.fillRect(food.x || 0, food.y || 0, score + 1, 10); }, 100);
      `,
    });
    expect(checks.every((check) => check.severity === "pass")).toBe(true);
  });

  it("blocks a typing-test mockup without real metrics", () => {
    const checks = reviewProductContract("做一个中文打字速度测试", {
      ...starterFiles,
      "index.html": '<main><textarea aria-label="输入"></textarea><button>完成</button></main>',
      "script.js": "document.querySelector('textarea').addEventListener('input', () => {});",
    });
    expect(checks).toHaveLength(4);
    expect(checks.find((check) => check.id === "typing-live-metrics")?.severity).toBe("error");
    expect(checks.find((check) => check.id === "typing-random-content")?.severity).toBe("error");
  });

  it("recognizes a functional Chinese typing-test loop", () => {
    const checks = reviewProductContract("中文 typing WPM 测试", {
      "index.html": '<main><p id="text"></p><textarea aria-label="打字输入"></textarea><output id="accuracy">正确率</output><output id="wpm">WPM</output><section id="result">成绩</section><button id="restart">再测一次</button></main>',
      "styles.css": "main{display:grid}",
      "script.js": `
        const texts = ['春风又绿江南岸', '生活明朗万物可爱'];
        let startTime = Date.now(), correct = 0;
        const target = texts[Math.floor(Math.random() * texts.length)];
        document.querySelector('textarea').addEventListener('compositionend', update);
        document.querySelector('textarea').addEventListener('input', update);
        document.querySelector('#restart').addEventListener('click', resetTest);
        function update(event) { const elapsed = (Date.now() - startTime) / 60000; const accuracy = correct / Math.max(1, event.target.value.length); const wpm = correct / elapsed; document.querySelector('#wpm').textContent = String(wpm); document.querySelector('#accuracy').textContent = String(accuracy); }
        function resetTest() { startTime = Date.now(); document.querySelector('#result').textContent = '成绩'; }
      `,
    });
    expect(checks.every((check) => check.severity === "pass")).toBe(true);
  });
});
