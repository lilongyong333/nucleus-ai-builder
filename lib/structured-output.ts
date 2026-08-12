import { artifactProtocolViolation, normalizeArtifactContent } from "./artifact-protocol";
import type { GeneratedFiles } from "./types";

/**
 * Parses the largest complete top-level JSON object in a model response.
 * This deliberately does not use eval or an executable "JSON repair" path.
 */
export function parseStructuredJsonObject(raw: string): Record<string, unknown> {
  const source = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = balancedJsonObjects(source)
    .sort((left, right) => right.length - left.length);

  for (const candidate of candidates) {
    for (const value of [candidate, removeTrailingJsonCommas(candidate)]) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // Try the next non-executable, structurally complete candidate.
      }
    }
  }
  throw new Error("模型没有返回可解析的完整 JSON 工件");
}

export function isCompleteJsonArtifact(raw: string): boolean {
  try {
    parseStructuredJsonObject(raw);
    return true;
  } catch {
    return false;
  }
}

export function isCompleteSingleFileArtifact(path: keyof GeneratedFiles, raw: string): boolean {
  const files = extractCompleteFileBlocks(raw);
  const content = files[path];
  if (!content || Object.keys(files).length !== 1) return false;
  return artifactProtocolViolation(path, normalizeArtifactContent(path, content)) === null;
}

export function isCompleteRepairArtifact(raw: string): boolean {
  const files = extractCompleteFileBlocks(raw);
  const entries = Object.entries(files) as Array<[keyof GeneratedFiles, string]>;
  return entries.length > 0 && entries.every(([path, content]) => artifactProtocolViolation(path, normalizeArtifactContent(path, content)) === null);
}

export function isCompleteThreeFileArtifact(raw: string): boolean {
  const files = extractCompleteFileBlocks(raw);
  return (["index.html", "styles.css", "script.js"] as const).every((path) => Boolean(files[path]));
}

function extractCompleteFileBlocks(raw: string): Partial<GeneratedFiles> {
  const files: Partial<GeneratedFiles> = {};
  const pattern = /```(?:html|css|javascript|js)?\s*\{\s*path\s*=\s*["']?([^}"'\s]+)["']?\s*\}\s*\r?\n([\s\S]*?)```/gi;
  for (const match of raw.matchAll(pattern)) {
    const path = match[1].replace(/^\.\//, "") as keyof GeneratedFiles;
    if (path === "index.html" || path === "styles.css" || path === "script.js") files[path] = match[2].trim();
  }
  return files;
}

function balancedJsonObjects(source: string): string[] {
  const results: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(source.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return results;
}

function removeTrailingJsonCommas(source: string): string {
  let result = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(source[lookahead] ?? "")) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }
    result += char;
  }
  return result;
}
