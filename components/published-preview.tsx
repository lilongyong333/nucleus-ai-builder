"use client";

import { useEffect, useMemo, useState } from "react";
import { composePreview } from "@/lib/runtime";
import type { AppRuntimeSession, GeneratedFiles } from "@/lib/types";

export function PublishedPreview({ files, title, slug, versionId }: { files: GeneratedFiles; title: string; slug: string; versionId: string | null }) {
  const [session, setSession] = useState<AppRuntimeSession | null>(null);

  useEffect(() => {
    const storageKey = `nucleus:app:${slug}:refresh`;
    const refreshToken = window.localStorage.getItem(storageKey) ?? undefined;
    fetch(`/api/runtime/${encodeURIComponent(slug)}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    }).then(async (response) => {
      const data = await response.json() as { session?: AppRuntimeSession };
      if (!response.ok || !data.session) return;
      if (data.session.refreshToken) window.localStorage.setItem(storageKey, data.session.refreshToken);
      setSession(data.session);
    }).catch(() => undefined);
  }, [slug]);

  const srcDoc = useMemo(() => composePreview(files, session ? {
    projectId: session.projectId,
    versionId,
    token: session.token,
    actor: session.actor,
    manifest: session.manifest,
    source: "published",
  } : { versionId, source: "published" }), [files, session, versionId]);

  return <iframe className="published-frame" title={title} sandbox="allow-scripts allow-forms allow-modals allow-popups" srcDoc={srcDoc} />;
}
