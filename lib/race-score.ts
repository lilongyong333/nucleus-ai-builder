import type { GeneratedFiles } from "./types";

export function scoreFileCandidate(path: keyof GeneratedFiles, content: string): number {
  let score = 45;
  const sizeTarget = path === "index.html" ? [800, 24_000] : path === "styles.css" ? [1_200, 50_000] : [1_200, 80_000];
  if (content.length >= sizeTarget[0] && content.length <= sizeTarget[1]) score += 10;
  if (path === "index.html") {
    if (/<main\b/i.test(content)) score += 8;
    if (/<meta\b[^>]*viewport/i.test(content)) score += 7;
    if (/<(?:button|input|select|textarea|form)\b/i.test(content)) score += 8;
    if (/\b(?:id|data-[a-z-]+)\s*=/i.test(content)) score += 7;
    if (/\baria-label\s*=|<label\b/i.test(content)) score += 5;
    if (!/<(?:style|script)\b/i.test(content)) score += 10;
  } else if (path === "styles.css") {
    if (/@media\b/i.test(content)) score += 10;
    if (/:focus-visible\b/i.test(content)) score += 8;
    if (/prefers-reduced-motion/i.test(content)) score += 8;
    if (/clamp\s*\(|min\s*\(|max\s*\(/i.test(content)) score += 7;
    if (/--[a-z0-9-]+\s*:/i.test(content)) score += 5;
    if (!/<\/?[a-z][\s\S]*>/i.test(content)) score += 7;
  } else {
    if (/addEventListener\s*\(/i.test(content)) score += 10;
    if (/window\.nucleus|\bnucleus\.data\./i.test(content)) score += 8;
    if (/try\s*\{|\.catch\s*\(/i.test(content)) score += 7;
    if (/keydown|pointer|touch/i.test(content)) score += 6;
    if (/function\s+render|\brender\s*=|requestAnimationFrame/i.test(content)) score += 7;
    if (!/<(?:style|script|html)\b/i.test(content)) score += 7;
  }
  return Math.max(0, Math.min(100, score));
}
