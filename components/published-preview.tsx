"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { applyPreviewStorageMutation, parsePreviewStorage } from "@/lib/preview-storage";
import { composePreview } from "@/lib/runtime";
import type { AppRuntimeSession, GeneratedFiles } from "@/lib/types";

export function PublishedPreview({ files, title, slug, projectId, versionId }: { files: GeneratedFiles; title: string; slug: string; projectId: string; versionId: string | null }) {
  const [session, setSession] = useState<AppRuntimeSession | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeStorageKey = `nucleus:preview-storage:${projectId}`;
  const [bridgeStorage, setBridgeStorage] = useState<Record<string, string>>({});
  const storageRef = useRef<Record<string, string>>(bridgeStorage);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      let stored: Record<string, string> = {};
      try { stored = parsePreviewStorage(window.localStorage.getItem(bridgeStorageKey)); } catch { /* storage disabled */ }
      storageRef.current = stored;
      setBridgeStorage(stored);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [bridgeStorageKey]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.data?.source !== "nucleus-preview" || event.data?.type !== "storage") return;
      const next = applyPreviewStorageMutation(storageRef.current, event.data);
      if (next === storageRef.current) return;
      storageRef.current = next;
      try { window.localStorage.setItem(bridgeStorageKey, JSON.stringify(next)); } catch { /* storage quota or privacy mode */ }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [bridgeStorageKey]);

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
    storage: bridgeStorage,
  } : { versionId, source: "published", storage: bridgeStorage }), [bridgeStorage, files, session, versionId]);

  return <iframe ref={iframeRef} className="published-frame" title={title} sandbox="allow-scripts allow-forms allow-modals allow-popups" srcDoc={srcDoc} />;
}
