"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- Vinext production RSC navigation currently throws; full document navigation is intentional. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowLeft, Bot, Boxes, Check, ChevronDown, CircleAlert, Clock3, Code2, Copy, Download, ExternalLink, FileCode2, Globe2, History, Laptop, ListChecks, LoaderCircle, Maximize2, MessageSquareText, Mic, MicOff, Monitor, PanelLeftClose, Play, Plus, RefreshCcw, RotateCcw, Send, Share2, ShieldCheck, Smartphone, Sparkles, Square, SquareTerminal, Trash2, UserRound, WandSparkles, X } from "lucide-react";
import { composePreview } from "@/lib/runtime";
import type { AgentEvent, AgentPlan, AppQualityReport, GeneratedFiles, Project, ProjectMessage } from "@/lib/types";

type TimelineItem = { id: string; agent: string; title: string; detail: string; state: "working" | "done" | "error"; time: string };
type LiveStreamState = { agent: string; phase: string; label: string; text: string; totalChars: number; done: boolean; model: string };
type QueuedPrompt = { id: string; content: string; createdAt: number };
type ConsoleEntry = { id: string; level: "log" | "info" | "warn" | "error"; message: string; time: string };
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<{ 0?: { transcript?: string } }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const agentTone: Record<string, string> = { Iris: "iris", Bob: "bob", Alex: "alex", Ray: "ray" };

export function Workbench({ projectId }: { projectId: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const startedRef = useRef(false);
  const generatingRef = useRef(false);
  const generationStartedAtRef = useRef<number | null>(null);
  const generationControllerRef = useRef<AbortController | null>(null);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [requestText, setRequestText] = useState("");
  const [activePrompt, setActivePrompt] = useState<string | null>(null);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [quickPromptsOpen, setQuickPromptsOpen] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [liveStream, setLiveStream] = useState<LiveStreamState | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [livePlan, setLivePlan] = useState<AgentPlan | null>(null);
  const [liveQuality, setLiveQuality] = useState<AppQualityReport | null>(null);
  const [activeTab, setActiveTab] = useState<"preview" | "code">("preview");
  const [activeFile, setActiveFile] = useState<keyof GeneratedFiles>("index.html");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [previewError, setPreviewError] = useState("");
  const [previewState, setPreviewState] = useState<"checking" | "passed" | "error">("checking");
  const [previewKey, setPreviewKey] = useState(0);
  const [showConsole, setShowConsole] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const [notice, setNotice] = useState("");
  const [showVersions, setShowVersions] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const activeRunStartedAt = project?.runs[0]?.startedAt ?? null;
  const projectStatus = project?.status;

  const handleEvent = useCallback((event: AgentEvent) => {
    if (event.type === "status") {
      setTimeline((items) => [...items.filter((item) => !(item.agent === event.agent && item.state === "working")), { id: crypto.randomUUID(), agent: event.agent, title: event.title, detail: event.detail, state: event.state, time: nowTime() }]);
    } else if (event.type === "progress") {
      setLiveStream((current) => {
        const sameStream = current?.phase === event.phase && current.model === event.model && event.totalChars >= current.totalChars;
        const text = sameStream ? `${current.text}${event.delta}` : event.delta;
        return { agent: event.agent, phase: event.phase, label: event.label, text: text.slice(-1800), totalChars: event.totalChars, done: event.done, model: event.model };
      });
    } else if (event.type === "plan") {
      setLivePlan(event.plan);
    } else if (event.type === "file") {
      setTimeline((items) => [...items, { id: crypto.randomUUID(), agent: "Alex", title: `写入 ${event.path}`, detail: `${Math.max(1, Math.round(event.size / 1000))} KB · 已完成`, state: "done", time: nowTime() }]);
    } else if (event.type === "review") {
      setLiveQuality(event.report);
    } else if (event.type === "complete") {
      setPreviewError("");
      setPreviewState("checking");
      setPreviewKey((value) => value + 1);
      setProject(event.project);
      setLivePlan(event.project.plan);
      setLiveQuality(currentQuality(event.project));
      setLiveStream(null);
      setActivePrompt(null);
      setActiveTab("preview");
      setNotice(`v${event.project.versions[0]?.versionNumber ?? 1} 已保存`);
    } else if (event.type === "error") {
      throw new Error(event.message);
    }
  }, []);

  const runGenerate = useCallback(async (prompt: string) => {
    const clean = prompt.trim();
    if (clean.length < 3 || generatingRef.current) return;
    generatingRef.current = true;
    generationStartedAtRef.current = Date.now();
    setGenerating(true);
    setActivePrompt(clean);
    setPreviewError("");
    setTimeline([]);
    setLiveStream(null);
    setElapsedSeconds(0);
    setLivePlan(null);
    setLiveQuality(null);
    setRequestText("");
    const generationController = new AbortController();
    generationControllerRef.current = generationController;
    try {
      const response = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, prompt: clean }), signal: generationController.signal });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || "生成请求失败");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          handleEvent(JSON.parse(line) as AgentEvent);
        }
        if (done) break;
      }
      if (buffer.trim()) handleEvent(JSON.parse(buffer) as AgentEvent);
    } catch (cause) {
      if (generationController.signal.aborted) {
        setTimeline((items) => [...items, { id: crypto.randomUUID(), agent: "Ray", title: "已取消生成", detail: "当前任务已停止，已保存版本不会受到影响。", state: "done", time: nowTime() }]);
        setNotice("已取消本次生成");
        return;
      }
      const message = cause instanceof Error ? cause.message : "生成失败";
      try {
        const response = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
        const data = await response.json() as { project?: Project };
        if (response.ok && data.project) {
          const recoveredProject = data.project;
          setProject(recoveredProject);
          setActivePrompt(null);
          setLivePlan(recoveredProject.plan);
          setLiveQuality(currentQuality(recoveredProject));
          setTimeline(timelineFromProject(recoveredProject));
          if (recoveredProject.status === "generating") {
            setLiveStream((current) => current ?? reconnectStream(recoveredProject));
            setTimeline((items) => [...items, { id: crypto.randomUUID(), agent: "Ray", title: "连接恢复中", detail: "已恢复云端执行记录，完成后会自动同步结果。", state: "working", time: nowTime() }]);
            setNotice("服务端仍在生成，正在自动恢复");
            return;
          }
          if (recoveredProject.status === "ready" && recoveredProject.versions.length > 0) {
            setTimeline((items) => [...items, { id: crypto.randomUUID(), agent: "Ray", title: "结果已恢复", detail: "已从云端同步服务端完成的版本。", state: "done", time: nowTime() }]);
            setNotice("已恢复服务端生成结果");
            return;
          }
        }
      } catch { /* keep the original transport error */ }
      setTimeline((items) => [...items, { id: crypto.randomUUID(), agent: "Ray", title: "生成中断", detail: message, state: "error", time: nowTime() }]);
      setNotice(message);
    } finally {
      if (generationControllerRef.current === generationController) generationControllerRef.current = null;
      generationStartedAtRef.current = null;
      generatingRef.current = false;
      setGenerating(false);
    }
  }, [handleEvent, projectId]);

  const cancelCurrentGeneration = useCallback(async () => {
    setQueuePaused(true);
    generationControllerRef.current?.abort();
    try {
      const response = await fetch(`/api/projects/${projectId}/cancel`, { method: "POST", keepalive: true });
      if (!response.ok) throw new Error("取消请求失败");
      const projectResponse = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
      const data = await projectResponse.json() as { project?: Project };
      if (projectResponse.ok && data.project) {
        setProject(data.project);
        setActivePrompt(null);
      }
    } catch {
      setNotice("本地请求已停止；服务端任务会由租约自动回收");
    }
  }, [projectId]);

  const submitPrompt = useCallback((value = requestText) => {
    const clean = value.trim();
    if (clean.length < 3) return;
    setRequestText("");
    setQuickPromptsOpen(false);
    if (generatingRef.current || projectStatus === "generating") {
      setQueuedPrompts((items) => [...items, { id: crypto.randomUUID(), content: clean, createdAt: Date.now() }]);
      setQueuePaused(false);
      setNotice("消息已加入生成队列");
      return;
    }
    setQueuePaused(false);
    void runGenerate(clean);
  }, [projectStatus, requestText, runGenerate]);

  const toggleVoiceInput = useCallback(() => {
    if (speechRecognitionRef.current) {
      speechRecognitionRef.current.stop();
      return;
    }
    const speechWindow = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setNotice("当前浏览器不支持语音识别，请使用 Chrome 或 Edge");
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0]?.transcript ?? "").join("").trim();
      if (transcript) setRequestText((current) => `${current}${current.trim() ? " " : ""}${transcript}`);
    };
    recognition.onerror = (event) => setNotice(event.error === "not-allowed" ? "请允许浏览器使用麦克风" : "语音识别没有成功，请再试一次");
    recognition.onend = () => {
      speechRecognitionRef.current = null;
      setIsListening(false);
    };
    speechRecognitionRef.current = recognition;
    setIsListening(true);
    recognition.start();
  }, []);

  useEffect(() => {
    fetch(`/api/projects/${projectId}`).then(async (response) => {
      const data = await response.json() as { error?: string; project: Project };
      if (!response.ok) throw new Error(data.error || "项目不存在");
      setProject(data.project);
      setLivePlan(data.project.plan);
      setLiveQuality(currentQuality(data.project));
      if (data.project.status === "generating" || data.project.status === "error") {
        setTimeline(timelineFromProject(data.project));
        setLiveStream(data.project.status === "generating" ? reconnectStream(data.project) : null);
      }
      return data.project as Project;
    }).then((value) => {
      if (value.status === "draft" && value.versions.length === 0 && !startedRef.current) {
        startedRef.current = true;
        void runGenerate(value.prompt);
      }
    }).catch((cause) => {
      const message = cause instanceof Error ? cause.message : "读取项目失败";
      setLoadError(message);
      setNotice(message);
    }).finally(() => setLoading(false));
  }, [projectId, runGenerate]);

  useEffect(() => {
    const busy = generating || projectStatus === "generating";
    if (!busy) return;
    const parsed = activeRunStartedAt ? Date.parse(activeRunStartedAt) : Number.NaN;
    const startedAt = generationStartedAtRef.current ?? (Number.isFinite(parsed) ? parsed : Date.now());
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [activeRunStartedAt, generating, projectStatus]);

  useEffect(() => {
    if (queuePaused || generating || projectStatus === "generating" || generatingRef.current || queuedPrompts.length === 0) return;
    const next = queuedPrompts[0];
    const timer = window.setTimeout(() => {
      setQueuedPrompts((items) => items[0]?.id === next.id ? items.slice(1) : items.filter((item) => item.id !== next.id));
      void runGenerate(next.content);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [generating, projectStatus, queuePaused, queuedPrompts, runGenerate]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => conversationEndRef.current?.scrollIntoView({ block: "end", behavior: liveStream ? "auto" : "smooth" }));
    return () => window.cancelAnimationFrame(frame);
  }, [activePrompt, liveStream, project?.messages.length, queuedPrompts.length, timeline.length]);

  useEffect(() => () => speechRecognitionRef.current?.stop(), []);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.data?.source !== "nucleus-preview") return;
      if (event.data.type === "error") {
        const message = String(event.data.message || "预览运行出错");
        setPreviewError(message);
        setPreviewState("error");
        setConsoleEntries((entries) => [...entries.slice(-99), { id: crypto.randomUUID(), level: "error", message, time: nowTime(true) }]);
      }
      if (event.data.type === "console") {
        const level = (["log", "info", "warn", "error"].includes(event.data.level) ? event.data.level : "log") as ConsoleEntry["level"];
        setConsoleEntries((entries) => [...entries.slice(-99), { id: crypto.randomUUID(), level, message: String(event.data.message || ""), time: nowTime(true) }]);
      }
      if (event.data.type === "ready") {
        setPreviewState("passed");
        setConsoleEntries((entries) => [...entries.slice(-99), { id: crypto.randomUUID(), level: "info", message: "应用启动完成，未发现阻塞错误", time: nowTime(true) }]);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (project?.status !== "generating" || generating) return;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
        const data = await response.json() as { project?: Project };
        if (!response.ok || !data.project || stopped) throw new Error("项目状态读取失败");
        setProject(data.project);
        if (data.project.status !== "generating") setActivePrompt(null);
        setLivePlan(data.project.plan);
        setLiveQuality(currentQuality(data.project));
        setTimeline(timelineFromProject(data.project));
        if (data.project.status === "generating") {
          setLiveStream((current) => current ?? reconnectStream(data.project!));
          timer = window.setTimeout(() => void poll(), 1800);
          return;
        }
        setLiveStream(null);
        if (data.project.status === "ready") {
          setPreviewError(""); setPreviewState("checking"); setPreviewKey((value) => value + 1);
          setTimeline((items) => [...items.filter((item) => item.title !== "连接恢复中"), { id: crypto.randomUUID(), agent: "Ray", title: "结果已恢复", detail: "后台生成完成，版本与审计记录已自动同步。", state: "done", time: nowTime() }]);
          setNotice("后台生成完成，结果已恢复");
        } else if (data.project.status === "error") {
          const detail = data.project.runs[0]?.error || "服务端生成失败";
          setTimeline((items) => [...items.filter((item) => item.title !== "连接恢复中"), { id: crypto.randomUUID(), agent: "Ray", title: "生成中断", detail, state: "error", time: nowTime() }]);
          setNotice(detail);
        }
      } catch {
        if (!stopped) timer = window.setTimeout(() => void poll(), 3000);
      }
    };
    timer = window.setTimeout(() => void poll(), 1200);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [generating, project?.status, projectId]);

  const srcDoc = useMemo(() => project ? composePreview(project.files) : "", [project]);

  function reloadPreview() {
    setPreviewError("");
    setPreviewState("checking");
    setConsoleEntries([{ id: crypto.randomUUID(), level: "info", message: "正在重新加载应用…", time: nowTime(true) }]);
    setPreviewKey((value) => value + 1);
  }

  async function restore(versionId: string) {
    const response = await fetch(`/api/projects/${projectId}/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ versionId }) });
    const data = await response.json() as { error?: string; project: Project };
    if (!response.ok) return setNotice(data.error || "恢复失败");
    setPreviewError(""); setPreviewState("checking"); setPreviewKey((value) => value + 1);
    setProject(data.project); setLiveQuality(currentQuality(data.project)); setShowVersions(false); setNotice("版本已恢复"); setActiveTab("preview");
  }

  async function publish() {
    const response = await fetch(`/api/projects/${projectId}/publish`, { method: "POST" });
    const data = await response.json() as { error?: string; project: Project };
    if (!response.ok) return setNotice(data.error || "发布失败");
    setProject(data.project);
    const url = `${window.location.origin}/p/${data.project.slug}`;
    await navigator.clipboard.writeText(url).catch(() => undefined);
    setNotice("公开链接已复制");
  }

  async function download() {
    if (!project) return;
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    Object.entries(project.files).forEach(([path, content]) => zip.file(path, content));
    zip.file("README.md", `# ${project.title}\n\n由 Nucleus 生成。直接双击 index.html 即可运行。\n`);
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${slugify(project.title)}.zip`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("代码包已下载");
  }

  if (loading) return <div className="workbench-loading"><span className="brand-mark"><Boxes size={22} /></span><LoaderCircle className="spin" size={22} /><p>正在打开工作台…</p></div>;
  if (!project) return <main className="workbench-load-error"><span className="brand-mark"><CircleAlert size={22} /></span><p>PROJECT ACCESS</p><h1>无法打开这个项目</h1><span>{loadError || "项目不存在，或它属于另一个账号 / 匿名会话。"}</span><a href="/"><ArrowLeft size={15} /> 返回首页创建新应用</a></main>;
  const latestRun = project.runs[0];
  const busy = generating || project.status === "generating";
  const displayTimeline = timeline.length > 0 ? timeline : timelineFromProject(project);
  const currentAgent = liveStream?.agent ?? displayTimeline.at(-1)?.agent ?? "Iris";
  const statusLabel = busy ? "生成中" : project.status === "error" ? "生成失败" : project.status === "ready" ? "已保存" : "草稿";
  const lastServerMessage = project.messages.at(-1);
  const shouldShowActivePrompt = Boolean(activePrompt && !(lastServerMessage?.role === "user" && lastServerMessage.content === activePrompt));
  const visibleMessages: ProjectMessage[] = shouldShowActivePrompt
    ? [...project.messages, { id: "active-prompt", projectId, role: "user", content: activePrompt!, createdAt: new Date().toISOString() }]
    : project.messages;
  const latestRunUserMessageId = [...project.messages].reverse().find((message) => message.role === "user" && message.content === latestRun?.prompt)?.id;
  const activityAfterMessageId = shouldShowActivePrompt ? "active-prompt" : latestRunUserMessageId;

  return (
    <main className={`workbench ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <header className="workbench-topbar">
        <div className="topbar-left"><a className="icon-button" href="/" aria-label="返回首页"><ArrowLeft size={18} /></a><a className="brand compact" href="/"><span className="brand-mark"><Boxes size={17} /></span><span>Nucleus</span></a><span className="top-divider" /><div className="project-title"><strong>{project.title}</strong><span className={`status-dot ${busy ? "busy" : project.status === "error" ? "failed" : ""}`} /> <small>{statusLabel}</small></div></div>
        <div className="topbar-actions"><a href="/account" aria-label="账号项目中心"><UserRound size={16} /><span>账号</span></a><button onClick={() => setShowMemory(true)}><MessageSquareText size={16} /><span>对话</span><b>{project.messages.length}</b></button><button onClick={() => setShowVersions(true)}><History size={16} /> <span>版本</span><b>v{project.versions[0]?.versionNumber ?? 0}</b></button><button onClick={() => void download()}><Download size={16} /><span>下载</span></button>{project.slug && <a href={`/p/${project.slug}`} target="_blank" rel="noreferrer"><ExternalLink size={16} /><span>查看发布页</span></a>}<button className="primary-action" onClick={() => void publish()}><Share2 size={16} /><span>{project.slug ? "复制链接" : "发布"}</span></button></div>
      </header>

      <aside className="agent-panel">
        <div className="panel-heading">
          <div><span>项目对话</span><small>{busy ? "智能体正在协作" : `${project.messages.length} 条云端记忆`}</small></div>
          <button className="icon-button" onClick={() => setSidebarOpen(false)} aria-label="收起侧栏"><PanelLeftClose size={17} /></button>
        </div>
        <div className="agent-roster">
          {["Iris", "Bob", "Alex", "Ray"].map((agent) => <div key={agent} className={`agent-avatar ${agentTone[agent]}`}>{agent.slice(0, 1)}<span className={busy && currentAgent === agent ? "online" : ""} /></div>)}
          <div className="roster-copy"><strong>{busy ? `${currentAgent} 正在工作` : "智能体团队已就绪"}</strong><span>规划 · 架构 · 工程 · 审查</span></div>
        </div>

        <div className="conversation-feed" aria-live="polite">
          {visibleMessages.length === 0 && <div className="conversation-empty"><Bot size={24} /><strong>开始和团队对话</strong><p>发送一个修改要求，消息、步骤和结果都会保存在这个项目里。</p></div>}
          {visibleMessages.map((message) => <div className="conversation-turn-group" key={message.id}>
            <ConversationMessage message={message} pending={message.id === "active-prompt"} onCopy={(content) => { void navigator.clipboard.writeText(content); setNotice("消息已复制"); }} />
            {message.id === activityAfterMessageId && (busy || displayTimeline.length > 0) && <AgentActivityPanel busy={busy} currentAgent={currentAgent} elapsedSeconds={elapsedSeconds} timeline={displayTimeline} liveStream={liveStream} plan={livePlan ?? project.plan} quality={liveQuality} run={latestRun} />}
          </div>)}
          <div ref={conversationEndRef} />
        </div>

        {queuedPrompts.length > 0 && <section className={`message-queue ${queuePaused ? "paused" : ""}`}>
          <header><span><ListChecks size={13} /> 待执行 {queuedPrompts.length}</span>{queuePaused && <button type="button" onClick={() => setQueuePaused(false)}>继续队列</button>}</header>
          {queuedPrompts.map((item, index) => <div key={item.id}><b>{index + 1}</b><span>{item.content}</span><button type="button" onClick={() => setQueuedPrompts((items) => items.filter((queued) => queued.id !== item.id))} aria-label={`移除队列消息 ${index + 1}`}><Trash2 size={12} /></button></div>)}
        </section>}

        <form className="conversation-composer" onSubmit={(event) => { event.preventDefault(); submitPrompt(); }}>
          {quickPromptsOpen && <div className="quick-prompt-menu">
            {["优化移动端布局和触控体验", "增加本地数据持久化和空状态", "检查并修复所有运行错误", "增强视觉层级和微交互"].map((prompt) => <button type="button" key={prompt} onClick={() => { setRequestText((current) => `${current}${current.trim() ? "\n" : ""}${prompt}`); setQuickPromptsOpen(false); }}>{prompt}</button>)}
          </div>}
          <textarea aria-label="修改需求" value={requestText} onChange={(event) => setRequestText(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submitPrompt();
            }
          }} placeholder="告诉团队你想修改什么…" />
          <div className="composer-actions">
            <button type="button" className={quickPromptsOpen ? "active" : ""} onClick={() => setQuickPromptsOpen((open) => !open)} aria-label="添加快捷指令"><Plus size={17} /></button>
            <button type="button" className={isListening ? "listening" : ""} onClick={toggleVoiceInput} aria-label={isListening ? "停止语音输入" : "开始语音输入"}>{isListening ? <MicOff size={16} /> : <Mic size={16} />}</button>
            <span>{busy ? "Return 加入队列" : "Return 发送"}<small>Shift + Return 换行</small></span>
            {busy ? <button type="button" className="composer-submit stop" onClick={() => void cancelCurrentGeneration()} aria-label="取消生成"><Square size={14} /></button> : project.status === "error" && requestText.trim().length < 3 ? <button type="button" className="composer-submit" onClick={() => void runGenerate(project.prompt)} aria-label="重试上次生成"><RefreshCcw size={14} /></button> : <button className="composer-submit" disabled={requestText.trim().length < 3} aria-label="发送修改需求"><Send size={15} /></button>}
          </div>
        </form>
      </aside>

      {!sidebarOpen && <button className="reopen-sidebar" onClick={() => setSidebarOpen(true)}><Bot size={18} /><span>智能体</span></button>}

      <section className="canvas-panel">
        <div className="canvas-toolbar">
          <div className="view-tabs"><button className={activeTab === "preview" ? "active" : ""} onClick={() => setActiveTab("preview")}><Play size={14} />应用查看器</button><button className={activeTab === "code" ? "active" : ""} onClick={() => setActiveTab("code")}><Code2 size={14} />代码文件</button></div>
          <div className="canvas-actions">
            <button className={showConsole ? "active" : ""} onClick={() => { setActiveTab("preview"); setShowConsole((open) => !open); }} aria-label="切换控制台"><SquareTerminal size={15} /></button>
            {activeTab === "preview" && <><div className={`runtime-status ${previewState}`}>{previewState === "checking" ? <LoaderCircle className="spin" size={12} /> : previewState === "passed" ? <Check size={12} /> : <CircleAlert size={12} />}<span>{previewState === "checking" ? "启动校验中" : previewState === "passed" ? "启动校验通过" : "发现运行错误"}</span></div><div className="device-toggle"><button className={device === "desktop" ? "active" : ""} onClick={() => setDevice("desktop")} aria-label="桌面预览"><Monitor size={15} /></button><button className={device === "mobile" ? "active" : ""} onClick={() => setDevice("mobile")} aria-label="手机预览"><Smartphone size={15} /></button></div></>}
            <button onClick={reloadPreview} aria-label="刷新"><RefreshCcw size={15} /></button><button onClick={() => iframeRef.current?.requestFullscreen()} aria-label="全屏"><Maximize2 size={15} /></button>
          </div>
        </div>

        {previewError && <div className="runtime-error"><CircleAlert size={16} /><div><strong>预览发现运行错误</strong><span>{previewError}</span></div><button onClick={() => void runGenerate(`请修复这个运行错误，并保持当前功能：${previewError}`)} disabled={busy}><Sparkles size={14} /> 让 Ray 修复</button><button className="icon-button" onClick={() => setPreviewError("")}><X size={14} /></button></div>}

        {activeTab === "preview" ? <div className={`preview-stage ${device}`}>
          {busy && <section className="generation-stream-card" aria-live="polite"><header><span className={`agent-avatar small ${agentTone[currentAgent] ?? "iris"}`}>{currentAgent.slice(0, 1)}</span><div><small>LIVE GENERATION</small><strong>{liveStream?.label ?? displayTimeline.at(-1)?.title ?? "正在连接模型"}</strong></div><time>{elapsedSeconds}s</time></header><pre>{liveStream?.text || "等待模型返回第一个内容片段…"}<i /></pre><footer><span>{liveStream?.totalChars ? `${liveStream.totalChars.toLocaleString("zh-CN")} 个字符已实时接收` : "正在建立流式连接"}</span><b>{liveStream?.done ? "本阶段完成" : "实时输出中"}</b></footer></section>}
          <div className="preview-browser"><div className="browser-bar"><span className="browser-dots"><i /><i /><i /></span><div><Globe2 size={12} /> nucleus.preview/{slugify(project.title)}</div><Laptop size={14} /></div><iframe key={previewKey} ref={iframeRef} title={`${project.title} 预览`} sandbox="allow-scripts allow-forms allow-modals allow-popups" srcDoc={srcDoc} /></div>
          {showConsole && <section className="runtime-console"><header><span><SquareTerminal size={14} /> 运行控制台</span><div><button onClick={() => setConsoleEntries([])}>清空</button><button onClick={() => setShowConsole(false)} aria-label="关闭控制台"><X size={13} /></button></div></header><div>{consoleEntries.length === 0 ? <p className="console-empty">暂无日志。应用中的 console 输出和运行错误会实时显示在这里。</p> : consoleEntries.map((entry) => <p className={entry.level} key={entry.id}><time>{entry.time}</time><b>{entry.level.toUpperCase()}</b><span>{entry.message}</span></p>)}</div></section>}
        </div> : <div className="code-workspace"><aside className="file-tree"><div><span>项目文件</span><small>3 files</small></div>{(Object.keys(project.files) as Array<keyof GeneratedFiles>).map((path) => <button key={path} className={activeFile === path ? "active" : ""} onClick={() => setActiveFile(path)}><FileCode2 size={15} /><span>{path}</span><small>{Math.max(1, Math.round(project.files[path].length / 1000))}k</small></button>)}</aside><section className="code-editor"><header><span>{activeFile}</span><button onClick={() => { void navigator.clipboard.writeText(project.files[activeFile]); setNotice("代码已复制"); }}><Copy size={14} />复制</button></header><pre><code>{project.files[activeFile]}</code></pre></section></div>}
      </section>

      {showVersions && <div className="drawer-backdrop"><button className="drawer-dismiss" onClick={() => setShowVersions(false)} aria-label="关闭版本历史" /><aside className="version-drawer"><header><div><span>版本历史</span><small>每次生成都会自动建立检查点</small></div><button className="icon-button" onClick={() => setShowVersions(false)}><X size={18} /></button></header><div className="version-list">{project.versions.map((version) => <article className={project.currentVersionId === version.id ? "current" : ""} key={version.id}><div className="version-number">v{version.versionNumber}</div><div><strong>{version.summary}</strong><span><Clock3 size={12} /> {new Date(version.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span><small>{version.model}{version.quality ? ` · Ray ${version.quality.score}/100` : ""}</small></div>{project.currentVersionId === version.id ? <b><Check size={12} />当前</b> : <button onClick={() => void restore(version.id)}><RotateCcw size={13} />恢复</button>}</article>)}</div></aside></div>}
      {showMemory && <div className="drawer-backdrop"><button className="drawer-dismiss" onClick={() => setShowMemory(false)} aria-label="关闭对话记忆" /><aside className="version-drawer memory-drawer"><header><div><span>项目对话记忆</span><small>登录后会随账号跨设备保存</small></div><button className="icon-button" onClick={() => setShowMemory(false)}><X size={18} /></button></header><div className="memory-list">{project.messages.length === 0 ? <div className="memory-empty"><MessageSquareText size={24} /><span>完成一次生成后，对话会出现在这里。</span></div> : project.messages.map((message) => <article className={message.role} key={message.id}><header><strong>{message.role === "user" ? "你" : "Nucleus 团队"}</strong><time>{new Date(message.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></header><p>{message.content}</p></article>)}</div></aside></div>}
      {notice && <div className="toast"><Check size={15} />{notice}</div>}
    </main>
  );
}

function ConversationMessage({ message, pending, onCopy }: { message: ProjectMessage; pending: boolean; onCopy: (content: string) => void }) {
  const timestamp = new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (message.role === "user") {
    return <article className={`conversation-message user ${pending ? "pending" : ""}`}>
      <div className="user-bubble"><p>{message.content}</p></div>
      <footer><span>{pending ? "本轮需求" : timestamp}</span><button onClick={() => onCopy(message.content)} aria-label="复制用户消息"><Copy size={12} /></button></footer>
    </article>;
  }
  return <article className="conversation-message assistant">
    <header><span className="agent-avatar small alex">A</span><div><strong>Alex</strong><small>工程师 · Nucleus 团队</small></div></header>
    <div className="assistant-bubble"><p>{message.content}</p></div>
    <footer><span>{timestamp}</span><button onClick={() => onCopy(message.content)} aria-label="复制智能体消息"><Copy size={12} /></button></footer>
  </article>;
}

function AgentActivityPanel({ busy, currentAgent, elapsedSeconds, timeline, liveStream, plan, quality, run }: {
  busy: boolean;
  currentAgent: string;
  elapsedSeconds: number;
  timeline: TimelineItem[];
  liveStream: LiveStreamState | null;
  plan: AgentPlan | null;
  quality: AppQualityReport | null;
  run: Project["runs"][number] | undefined;
}) {
  const completedSteps = timeline.filter((item) => item.state === "done").length;
  const agent = busy ? currentAgent : "Alex";
  const role = ({ Iris: "产品规划", Bob: "架构师", Alex: "工程师", Ray: "质量审查" } as Record<string, string>)[agent] ?? "智能体";
  return <article className={`agent-activity-turn ${busy ? "working" : "completed"}`}>
    <header><span className={`agent-avatar small ${agentTone[agent] ?? "alex"}`}>{agent.slice(0, 1)}</span><div><strong>{agent}</strong><small>{role} · {busy ? "正在跟随你的要求" : "本轮工作已完成"}</small></div>{busy && <time>{elapsedSeconds}s</time>}</header>
    <details className="agent-step-card" open={busy || undefined}>
      <summary><span>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{busy ? `已处理 ${completedSteps} 步，正在执行` : `已处理 ${Math.max(completedSteps, timeline.length)} 步`}</span><ChevronDown size={14} /></summary>
      <div className="agent-step-list">
        {timeline.length === 0 && <div className="agent-step pending"><i /><div><strong>连接实时执行记录</strong><p>首个智能体事件到达后会立即显示。</p></div></div>}
        {timeline.map((item) => <div className={`agent-step ${item.state}`} key={item.id}><span className={`agent-avatar small ${agentTone[item.agent] ?? "ray"}`}>{item.agent.slice(0, 1)}</span><div><header><strong>{item.agent} · {item.title}</strong><time>{item.time}</time></header><p>{item.detail}</p></div></div>)}
      </div>
    </details>
    {busy && <div className="inline-stream"><header><span>{liveStream?.label ?? timeline.at(-1)?.title ?? "正在连接模型"}</span><b>{liveStream?.totalChars ? `${liveStream.totalChars.toLocaleString("zh-CN")} 字符` : "连接中"}</b></header><pre>{liveStream?.text || "等待模型返回第一个内容片段…"}<i /></pre></div>}
    {plan && <details className="conversation-plan"><summary><span><WandSparkles size={13} /> 当前实现计划</span><ChevronDown size={13} /></summary><strong>{plan.summary}</strong><ul>{plan.features.slice(0, 4).map((feature) => <li key={feature}><Check size={11} />{feature}</li>)}</ul></details>}
    {quality && !busy && <div className={`conversation-quality ${quality.passed ? "passed" : "failed"}`}><span><ShieldCheck size={14} /> Ray 质量门</span><strong>{quality.score}<small>/100 · {quality.grade} 级</small></strong></div>}
    {run && !busy && <details className={`run-audit-card conversation-audit ${run.status}`}><summary><span><Activity size={13} /> 执行审计</span><b>{runStatusLabel(run.status)}</b></summary><div className="run-metrics"><span><strong>{formatDuration(run.durationMs)}</strong><small>总耗时</small></span><span><strong>{run.usage.totalTokens || "—"}</strong><small>Tokens</small></span><span><strong>{run.modelCalls}</strong><small>模型调用</small></span><span><strong>{run.events.length}</strong><small>事件</small></span></div><ol>{run.events.map((event) => <li key={event.id}><i className={event.state} /><div><strong>{event.agent} · {event.title}</strong><small>{event.durationMs === null ? event.phase : `${event.phase} · ${formatDuration(event.durationMs)}`}{event.usage.totalTokens ? ` · ${event.usage.totalTokens} tokens` : ""}</small></div></li>)}</ol><footer><code>{run.id.slice(0, 8)}</code><span>{run.model}{run.repairCount ? ` · ${run.repairCount} 次修复` : ""}</span></footer></details>}
  </article>;
}

function nowTime(withSeconds = false) { return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" as const } : {}) }); }
function slugify(value: string) { return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "") || "nucleus-app"; }
function currentQuality(project: Project): AppQualityReport | null { return project.versions.find((version) => version.id === project.currentVersionId)?.quality ?? project.versions[0]?.quality ?? null; }
function formatDuration(value: number | null) { return value === null ? "—" : value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`; }
function runStatusLabel(status: Project["runs"][number]["status"]) { return ({ running: "进行中", completed: "已完成", failed: "失败", cancelled: "已取消", rejected: "已拒绝" })[status]; }
function timelineFromProject(project: Project): TimelineItem[] {
  const items: TimelineItem[] = [];
  const run = project.runs[0];
  for (const event of run?.events ?? []) {
    const withoutWorking = items.filter((item) => !(item.agent === event.agent && item.state === "working"));
    withoutWorking.push({ id: event.id, agent: event.agent, title: event.title, detail: event.detail, state: event.state, time: new Date(event.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) });
    items.splice(0, items.length, ...withoutWorking);
  }
  if (project.status === "error" && run?.error && !run.events.some((event) => event.state === "error")) {
    items.push({ id: `${run.id}-recovered-error`, agent: "Ray", title: "生成任务已停止", detail: run.error, state: "error", time: nowTime() });
  }
  return items;
}
function reconnectStream(project: Project): LiveStreamState {
  const event = project.runs[0]?.events.at(-1);
  return { agent: event?.agent ?? "Iris", phase: event?.phase ?? "reconnect", label: event?.title ?? "正在恢复实时执行记录", text: "此任务已在云端开始，页面正在同步已保存的智能体事件…", totalChars: 0, done: false, model: event?.model ?? project.runs[0]?.model ?? "" };
}
