"use client";

import { composePreview } from "@/lib/runtime";
import type { GeneratedFiles } from "@/lib/types";

export function PublishedPreview({ files, title }: { files: GeneratedFiles; title: string }) {
  return <iframe className="published-frame" title={title} sandbox="allow-scripts allow-forms allow-modals allow-popups" srcDoc={composePreview(files)} />;
}
