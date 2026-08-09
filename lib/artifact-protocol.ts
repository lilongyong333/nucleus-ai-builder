import { parse } from "acorn";
import type { GeneratedFiles } from "./types";

export const canonicalFileResponsibilities: Record<keyof GeneratedFiles, string> = {
  "index.html": "完整语义 HTML、应用容器、Canvas 与可访问控件；禁止内联 <style> 或 <script>，不得实现 CSS 或 JavaScript。",
  "styles.css": "完整独立 CSS；负责产品级视觉、响应式布局、交互状态与可见焦点，不得包含 HTML 或 JavaScript。",
  "script.js": "完整独立原生 JavaScript；负责状态机、业务规则、交互、持久化与错误处理，不得包含 HTML 或 CSS。",
};

export function artifactProtocolViolation(path: keyof GeneratedFiles, content: string): string | null {
  const source = content.trim();
  if (/```|\{\s*path\s*=\s*/i.test(source)) return `${path} 仍包含 Markdown 围栏或文件协议标记`;

  if (path === "index.html") {
    if (/<style\b/i.test(source) || /<script\b/i.test(source)) return "index.html 包含内联 style/script，违反三文件隔离协议";
    if (!/^\s*<!doctype\s+html\b/i.test(source) || !/<html\b/i.test(source) || !/<body\b/i.test(source) || !/<\/body\s*>/i.test(source) || !/<\/html\s*>\s*$/i.test(source)) {
      return "index.html 不是完整 HTML 文档，可能在流式输出中被截断";
    }
    return null;
  }

  if (path === "styles.css") {
    if (/<(?:!doctype|html|head|body|script)\b/i.test(source)) return "styles.css 包含 HTML 或 JavaScript 标签，违反三文件隔离协议";
    if (!hasBalancedCssBraces(source)) return "styles.css 花括号不完整，可能在流式输出中被截断";
    return null;
  }

  if (/<(?:!doctype|html|head|body|style)\b/i.test(source)) return "script.js 包含 HTML 或 CSS 标签，违反三文件隔离协议";
  try {
    parse(source, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true });
  } catch (error) {
    return `script.js JavaScript 语法不完整：${error instanceof Error ? error.message : "无法解析"}`;
  }
  return null;
}

function hasBalancedCssBraces(source: string): boolean {
  let depth = 0;
  let quote = "";
  let inComment = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (inComment) {
      if (current === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === "/" && next === "*") {
      inComment = true;
      index += 1;
    } else if (current === "\"" || current === "'") quote = current;
    else if (current === "{") depth += 1;
    else if (current === "}" && --depth < 0) return false;
  }
  return !inComment && !quote && depth === 0;
}
