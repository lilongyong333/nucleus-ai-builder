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

  const score = checks.reduce((total, check) => total + (check.severity === "pass" ? check.weight : 0), 0);
  const blockingIssues = checks.filter((check) => check.severity === "error");
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

export function qualityRepairBrief(report: AppQualityReport): string {
  return report.checks
    .filter((check) => check.severity !== "pass")
    .map((check) => `- ${check.label}: ${check.detail}`)
    .join("\n");
}
