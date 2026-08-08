import { normalizeGeneratedFiles } from "./runtime";
import type { GeneratedFiles } from "./types";

export function parseGeneratedReply(raw: string, fallbackSummary: string, currentFiles?: GeneratedFiles): { files: GeneratedFiles; summary: string } {
  const files: Partial<GeneratedFiles> = {};
  const pattern = /```(?:html|css|javascript|js)?\s*\{\s*path\s*=\s*["']?([^}"'\s]+)["']?\s*\}\s*\r?\n([\s\S]*?)```/gi;
  for (const match of raw.matchAll(pattern)) {
    const path = match[1].replace(/^\.\//, "") as keyof GeneratedFiles;
    if (path === "index.html" || path === "styles.css" || path === "script.js") files[path] = match[2].trim();
  }
  const summaryMatch = raw.match(/<summary>([\s\S]*?)<\/summary>/i);
  return {
    files: normalizeGeneratedFiles({ ...(currentFiles ?? {}), ...files }),
    summary: (summaryMatch?.[1].trim() || fallbackSummary).slice(0, 500),
  };
}
