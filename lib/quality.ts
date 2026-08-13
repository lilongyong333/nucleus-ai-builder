import { parse, type Node } from "acorn";
import type { AppQualityCheck, AppQualityReport, GeneratedFiles } from "./types";

type CheckInput = {
  id: string;
  label: string;
  passed: boolean;
  passDetail: string;
  failDetail: string;
  weight: number;
  blocking?: boolean;
};

function makeCheck(input: CheckInput): AppQualityCheck {
  return {
    id: input.id,
    label: input.label,
    severity: input.passed ? "pass" : input.blocking ? "error" : "warning",
    detail: input.passed ? input.passDetail : input.failDetail,
    weight: input.weight,
  };
}

function grade(score: number): AppQualityReport["grade"] {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  return "D";
}

function isNode(value: unknown): value is Node {
  return Boolean(value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string");
}

function identifierName(value: unknown): string {
  return isNode(value) && value.type === "Identifier" ? String((value as Node & { name?: string }).name ?? "") : "";
}

function hasRiskyRuntimeNode(root: Node): boolean {
  let risky = false;
  const visit = (node: Node) => {
    if (risky) return;
    const value = node as Node & { callee?: unknown; object?: unknown; property?: unknown };
    if (node.type === "CallExpression" && identifierName(value.callee) === "eval") risky = true;
    if (node.type === "NewExpression" && identifierName(value.callee) === "Function") risky = true;
    if (node.type === "CallExpression" && isNode(value.callee) && value.callee.type === "MemberExpression") {
      const member = value.callee as Node & { object?: unknown; property?: unknown };
      if (identifierName(member.object) === "document" && identifierName(member.property) === "write") risky = true;
    }
    if (node.type === "MemberExpression") {
      const objectName = identifierName(value.object);
      const propertyName = identifierName(value.property);
      if ((objectName === "parent" || objectName === "top") && propertyName === "document") risky = true;
      if (objectName === "opener") risky = true;
    }
    for (const child of Object.values(node as unknown as Record<string, unknown>)) {
      if (isNode(child)) visit(child);
      else if (Array.isArray(child)) child.filter(isNode).forEach(visit);
    }
  };
  visit(root);
  return risky;
}

function duplicateFunctionNames(root: Node): string[] {
  const duplicates = new Set<string>();
  const visit = (node: Node) => {
    if (node.type === "Program" || node.type === "BlockStatement") {
      const body = (node as Node & { body?: unknown }).body;
      if (Array.isArray(body)) {
        const seen = new Set<string>();
        for (const statement of body.filter(isNode)) {
          if (statement.type !== "FunctionDeclaration") continue;
          const name = identifierName((statement as Node & { id?: unknown }).id);
          if (!name) continue;
          if (seen.has(name)) duplicates.add(name);
          seen.add(name);
        }
      }
    }
    for (const child of Object.values(node as unknown as Record<string, unknown>)) {
      if (isNode(child)) visit(child);
      else if (Array.isArray(child)) child.filter(isNode).forEach(visit);
    }
  };
  visit(root);
  return [...duplicates].sort();
}

export function reviewGeneratedApp(files: GeneratedFiles): AppQualityReport {
  const html = files["index.html"];
  const css = files["styles.css"];
  const script = files["script.js"];
  const checks: AppQualityCheck[] = [];

  let syntaxError = "";
  let syntaxTree: Node | null = null;
  try {
    syntaxTree = parse(script, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true });
  } catch (error) {
    syntaxError = error instanceof Error ? error.message : "JavaScript 无法解析";
  }
  checks.push(makeCheck({
    id: "javascript-syntax",
    label: "JavaScript 语法",
    passed: !syntaxError,
    passDetail: "脚本通过 ECMAScript 语法解析",
    failDetail: `脚本存在语法错误：${syntaxError}`,
    weight: 24,
    blocking: true,
  }));

  const duplicateFunctions = syntaxTree ? duplicateFunctionNames(syntaxTree) : [];
  checks.push(makeCheck({
    id: "function-uniqueness",
    label: "函数声明唯一性",
    passed: duplicateFunctions.length === 0,
    passDetail: "同一作用域内没有重复函数声明",
    failDetail: `同一作用域存在重复函数声明：${duplicateFunctions.join("、")}；后声明会覆盖前声明并导致运行错误`,
    weight: 0,
    blocking: true,
  }));

  const hasRiskyCode = syntaxTree ? hasRiskyRuntimeNode(syntaxTree) : false;
  checks.push(makeCheck({
    id: "runtime-safety",
    label: "运行安全边界",
    passed: !hasRiskyCode,
    passDetail: "未发现动态执行或跨窗口 DOM 操作",
    failDetail: "发现 eval、Function、document.write 或跨窗口 DOM 等高风险调用",
    weight: 18,
    blocking: true,
  }));

  const hasInteractiveMarkup = /<(button|input|select|textarea|form|details)\b|\brole\s*=\s*["']button["']/i.test(html);
  const hasInteractionCode = /\.addEventListener\s*\(|\bon(?:click|change|input|submit|keydown)\s*=/i.test(script) || /\bon(?:click|change|input|submit|keydown)\s*=/i.test(html);
  const hasInteraction = hasInteractiveMarkup && hasInteractionCode;
  checks.push(makeCheck({
    id: "real-interaction",
    label: "真实交互",
    passed: hasInteraction,
    passDetail: "页面包含交互控件和事件处理逻辑",
    failDetail: "没有同时检测到可操作控件与对应事件处理",
    weight: 18,
    blocking: true,
  }));

  const hasSemanticStructure = /<(main|header|nav|section|article|aside|footer)\b/i.test(html);
  checks.push(makeCheck({
    id: "semantic-html",
    label: "语义结构",
    passed: hasSemanticStructure,
    passDetail: "使用了 main、section 等语义元素",
    failDetail: "建议用语义元素组织页面，而不是只使用 div",
    weight: 8,
  }));

  const hasViewport = /<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(html);
  checks.push(makeCheck({
    id: "viewport",
    label: "移动端视口",
    passed: hasViewport,
    passDetail: "已声明响应式 viewport",
    failDetail: "缺少 viewport meta，手机端可能缩放异常",
    weight: 7,
  }));

  const hasResponsiveCss = /@media\b/i.test(css) || /clamp\s*\(|min\s*\(|max\s*\(/i.test(css);
  checks.push(makeCheck({
    id: "responsive-css",
    label: "响应式样式",
    passed: hasResponsiveCss,
    passDetail: "存在媒体查询或流体尺寸规则",
    failDetail: "没有检测到媒体查询或流体尺寸规则",
    weight: 10,
  }));

  const hasFormControls = /<(input|select|textarea)\b/i.test(html);
  const hasAccessibleNames = !hasFormControls || /<label\b|\baria-label\s*=|\baria-labelledby\s*=|\btitle\s*=/i.test(html);
  checks.push(makeCheck({
    id: "accessible-names",
    label: "表单可访问性",
    passed: hasAccessibleNames,
    passDetail: hasFormControls ? "表单控件具有可识别名称" : "页面没有需要命名的表单控件",
    failDetail: "表单控件缺少 label 或 aria-label",
    weight: 8,
  }));

  const hasFocusStyle = /:(?:focus|focus-visible)\b/i.test(css);
  checks.push(makeCheck({
    id: "keyboard-focus",
    label: "键盘焦点",
    passed: hasFocusStyle,
    passDetail: "样式中包含键盘焦点反馈",
    failDetail: "没有检测到 :focus 或 :focus-visible 样式",
    weight: 5,
  }));

  const hasExternalCode = /<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["']https?:\/\//i.test(html);
  checks.push(makeCheck({
    id: "self-contained",
    label: "自包含交付",
    passed: !hasExternalCode,
    passDetail: "未依赖外部脚本或样式资源",
    failDetail: "检测到外部脚本或样式，离线导出可能失效",
    weight: 2,
  }));

  const blockingIssues = checks.filter((check) => check.severity === "error");
  const rawScore = checks.reduce((total, check) => total + (check.severity === "pass" ? check.weight : 0), 0);
  // A blocking runtime/safety defect must never be presented as 100/A merely
  // because its dedicated contract has zero scoring weight.
  const score = blockingIssues.length > 0 ? Math.min(rawScore, 69) : rawScore;
  const passed = blockingIssues.length === 0 && score >= 75;
  return {
    score,
    grade: grade(score),
    passed,
    checks,
    summary: passed
      ? `Ray 完成 ${checks.length} 项检查，质量评分 ${score}/100`
      : `Ray 发现 ${blockingIssues.length || checks.filter((check) => check.severity === "warning").length} 项需要修复的问题`,
  };
}

/**
 * Small deterministic contracts for app archetypes where a polished static
 * mock can otherwise look convincing. These checks do not replace Ray's model
 * review; they provide hard, auditable evidence for the core runtime loop.
 */
export function reviewProductContract(prompt: string, files: GeneratedFiles): AppQualityCheck[] {
  const request = prompt.toLowerCase();
  if (/(打字|打字速度|typing|type speed|wpm|cpm)/i.test(request)) return typingProductChecks(files);
  if (/(财务|预算|支出|收入|记账|finance|budget|expense|income)/i.test(request)) return financeProductChecks(files);
  if (!/(贪吃蛇|snake)/i.test(request)) return [];

  const html = files["index.html"];
  const script = files["script.js"];
  const source = `${html}\n${script}`;
  return [
    makeCheck({
      id: "snake-runtime-loop",
      label: "贪吃蛇运行循环",
      passed: /\b(?:setInterval|requestAnimationFrame|setTimeout)\s*\(/.test(script),
      passDetail: "检测到驱动游戏持续运行的计时或动画循环",
      failDetail: "没有检测到游戏循环，页面可能只是静态演示",
      weight: 0,
      blocking: true,
    }),
    makeCheck({
      id: "snake-direction-controls",
      label: "方向控制",
      passed: /(?:keydown|keyup)/i.test(source) && /(?:ArrowUp|ArrowDown|ArrowLeft|ArrowRight|KeyW|KeyA|KeyS|KeyD|\bwasd\b)/i.test(source),
      passDetail: "检测到键盘方向输入和对应按键映射",
      failDetail: "缺少可验证的键盘方向控制",
      weight: 0,
      blocking: true,
    }),
    makeCheck({
      id: "snake-rendering",
      label: "游戏场景渲染",
      passed: /getContext\s*\(\s*["']2d["']\s*\)|createElement\s*\(|grid-template/i.test(source),
      passDetail: "检测到 Canvas 或 DOM/CSS 网格场景渲染",
      failDetail: "没有检测到可运行的游戏场景渲染逻辑",
      weight: 0,
      blocking: true,
    }),
    makeCheck({
      id: "snake-food-score",
      label: "食物与计分",
      passed: /\b(?:food|apple|score|points?)\b/i.test(script) && /(?:textContent|innerText|draw|fillRect|appendChild)/i.test(script),
      passDetail: "检测到食物/分数状态及其界面更新",
      failDetail: "缺少食物、得分或得分展示的完整证据",
      weight: 0,
      blocking: true,
    }),
    makeCheck({
      id: "snake-lifecycle",
      label: "碰撞与生命周期",
      passed: /\b(?:collision|gameOver|gameover|restart|resetGame|startGame|pauseGame|isPaused|wall)\b/i.test(script),
      passDetail: "检测到碰撞、结束、重开或暂停等生命周期逻辑",
      failDetail: "缺少碰撞/结束/重开等游戏生命周期证据",
      weight: 0,
      blocking: true,
    }),
  ];
}

function typingProductChecks(files: GeneratedFiles): AppQualityCheck[] {
  const html = files["index.html"];
  const script = files["script.js"];
  const source = `${html}\n${script}`;
  return [
    makeCheck({
      id: "typing-real-input",
      label: "真实打字输入",
      passed: /<(?:input|textarea)\b/i.test(html) && /(?:input|beforeinput|compositionend)/i.test(script),
      passDetail: "检测到可输入控件及输入/中文输入法事件",
      failDetail: "缺少真实输入控件或 input/compositionend 处理，页面可能无法完成打字测试",
      weight: 0,
      blocking: true,
    }),
    makeCheck({
      id: "typing-live-metrics",
      label: "正确率与速度统计",
      passed: /(?:accuracy|correct|正确率|正确字符)/i.test(source) && /(?:wpm|cpm|每分钟|字数\/分)/i.test(source) && /(?:elapsed|duration|startTime|Date\.now|performance\.now|计时|用时)/i.test(script),
      passDetail: "检测到正确率、每分钟速度和计时证据",
      failDetail: "缺少正确率、WPM/CPM 或计时计算，无法满足核心实时统计需求",
      weight: 0,
      blocking: true,
    }),
    makeCheck({
      id: "typing-rate-safety",
      label: "极速输入速率边界",
      passed: hasSafeElapsedFloor(script),
      passDetail: "速度计算将有效用时下限限制为至少 1 秒，瞬时粘贴或自动化输入不会产生无限/百万级速率",
      failDetail: "速度计算没有把有效用时限制到至少 1 秒；瞬时输入可能得到 Infinity 或数百万 CPM/WPM",
      weight: 0,
      blocking: true,
    }),
    makeCheck({
      id: "typing-random-content",
      label: "随机题库",
      passed: /Math\.random\s*\(|crypto\.getRandomValues\s*\(/.test(script) && /\[[\s\S]*["'`][\s\S]*["'`][\s\S]*\]/.test(script),
      passDetail: "检测到本地题库和随机选择逻辑",
      failDetail: "缺少题库随机选择逻辑，每次测试可能始终展示相同文本",
      weight: 0,
      blocking: true,
    }),
    makeCheck({
      id: "typing-results-restart",
      label: "完成、成绩与重试",
      passed: /(?:result|score|成绩|评级|完成)/i.test(source) && /(?:restart|reset|retry|again|再测|重试|重新)/i.test(source),
      passDetail: "检测到完成成绩和重新开始流程",
      failDetail: "缺少完成后的成绩展示或重新测试流程",
      weight: 0,
      blocking: true,
    }),
  ];
}

function hasSafeElapsedFloor(script: string): boolean {
  const timeTerm = "(?:elapsed|duration|seconds|timeTaken|timeElapsed|用时|耗时)";
  const floorFirst = new RegExp(`Math\\.max\\s*\\(\\s*(?:1(?:\\.0+)?|1000(?:\\.0+)?)\\s*,[\\s\\S]{0,220}${timeTerm}`, "i");
  const floorSecond = new RegExp(`Math\\.max\\s*\\([\\s\\S]{0,220}${timeTerm}[\\s\\S]{0,100},\\s*(?:1(?:\\.0+)?|1000(?:\\.0+)?)\\s*\\)`, "i");
  const guardedAssignment = new RegExp(`${timeTerm}[\\s\\S]{0,100}(?:<=?\\s*0|<\\s*1)[\\s\\S]{0,100}${timeTerm}[\\s\\S]{0,30}=\\s*1`, "i");
  return floorFirst.test(script) || floorSecond.test(script) || guardedAssignment.test(script);
}

function financeProductChecks(files: GeneratedFiles): AppQualityCheck[] {
  const html = files["index.html"];
  const css = files["styles.css"];
  const script = files["script.js"];
  const source = `${html}\n${script}`;
  const togglesHiddenAttribute = /(?:hidden\s*=|setAttribute\s*\(\s*["']hidden)/i.test(script);
  const emptyStateForcesVisibleDisplay = /\.empty-state\s*\{[\s\S]*?\bdisplay\s*:\s*(?!none\b)[^;}]+/i.test(css);
  const hasHiddenDisplayOverride = /(?:\[hidden\]|\.empty-state\[hidden\])\s*\{[\s\S]*?\bdisplay\s*:\s*none\b/i.test(css);
  const togglesInlineDisplay = /style\.display\s*=/i.test(script);
  return [
    makeCheck({
      id: "finance-real-entry",
      label: "真实收支录入",
      passed: /<(?:form|input|select)\b/i.test(html) && /(?:submit|click|change)\b/i.test(script) && /(?:amount|金额|expense|income|支出|收入)/i.test(source),
      passDetail: "检测到金额/类型录入控件和真实提交处理",
      failDetail: "缺少可提交的收支录入表单或事件处理，可能只是静态仪表盘",
      weight: 0,
      blocking: true,
    }),
    makeCheck({
      id: "finance-live-aggregate",
      label: "汇总联动",
      passed: /(?:reduce\s*\(|forEach\s*\(|for\s*\()/i.test(script) && /(?:total|balance|summary|结余|合计|总收入|总支出)/i.test(source) && /(?:textContent|innerText)/i.test(script),
      passDetail: "检测到基于交易记录重新计算并更新汇总指标",
      failDetail: "新增交易后没有足够证据证明收入、支出或结余会重新计算",
      weight: 0,
      blocking: true,
    }),
    makeCheck({
      id: "finance-empty-state",
      label: "空状态切换",
      passed: /(?:empty|空状态|暂无|no-transactions|noData)/i.test(source) && /(?:\.length|length\s*[=!<>])/.test(script) && /(?:hidden\s*=|classList\.(?:add|remove|toggle)|style\.display|setAttribute\s*\(\s*["']hidden)/i.test(script),
      passDetail: "检测到交易为空/非空时显式显示或隐藏空状态",
      failDetail: "空状态没有与交易数量联动，新增记录后仍可能显示“暂无数据”",
      weight: 0,
      blocking: true,
    }),
    makeCheck({
      id: "finance-hidden-visibility",
      label: "空状态真实隐藏",
      passed: !togglesHiddenAttribute || !emptyStateForcesVisibleDisplay || hasHiddenDisplayOverride || togglesInlineDisplay,
      passDetail: "空状态 hidden 切换不会被作者样式中的 display 规则重新显示",
      failDetail: "脚本给空状态设置了 hidden，但 .empty-state 的 display 样式会把它继续显示；请在 styles.css 添加 [hidden]{display:none!important} 或改用可靠的显隐方式",
      weight: 0,
      blocking: true,
    }),
    makeCheck({
      id: "finance-persistence",
      label: "交易持久化",
      passed: /(?:localStorage\.(?:setItem|getItem)|nucleus\.data\.(?:list|create|update|remove))/i.test(script),
      passDetail: "检测到交易记录的读取与持久化路径",
      failDetail: "刷新后交易可能全部丢失，缺少 localStorage 或平台数据 API",
      weight: 0,
      blocking: true,
    }),
  ];
}

export function qualityRepairBrief(report: AppQualityReport): string {
  return report.checks
    .filter((check) => check.severity !== "pass")
    .map((check) => `- ${check.label}: ${check.detail}`)
    .join("\n");
}

export type GroundedQualityIssue = {
  severity: "error";
  file: keyof GeneratedFiles | "application";
  detail: string;
};

/**
 * Preserve the exact deterministic failure and point Ray at the file that can
 * actually fix it. Without this bridge the model reviewer can correctly fail
 * a run while the repair agent receives only a vague application-level issue.
 */
export function qualityIssuesFromChecks(checks: AppQualityCheck[]): GroundedQualityIssue[] {
  return checks
    .filter((check) => check.severity === "error")
    .map((check) => ({
      severity: "error" as const,
      file: qualityCheckFile(check.id),
      detail: check.detail,
    }));
}

export function requiredQualityIssueFiles(issues: Array<{ severity: "warning" | "error"; file: keyof GeneratedFiles | "application" }>): Array<keyof GeneratedFiles> {
  return [...new Set(issues.flatMap((issue) => issue.severity === "error" && issue.file !== "application" ? [issue.file] : []))];
}

function qualityCheckFile(checkId: string): keyof GeneratedFiles | "application" {
  if (["javascript-syntax", "function-uniqueness", "runtime-safety"].includes(checkId)) return "script.js";
  if (["semantic-html", "viewport", "accessible-names", "self-contained"].includes(checkId)) return "index.html";
  if (["responsive-css", "keyboard-focus"].includes(checkId)) return "styles.css";
  if (checkId === "finance-hidden-visibility") return "styles.css";
  if (checkId.startsWith("snake-") || checkId.startsWith("typing-") || checkId.startsWith("finance-")) return "script.js";
  return "application";
}
