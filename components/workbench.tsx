"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Activity, ArrowLeft, Bot, Boxes, Check, CircleAlert, Clock3, Code2, Copy, Download, ExternalLink, FileCode2, Globe2, History, Laptop, LoaderCircle, Maximize2, MessageSquareText, Monitor, PanelLeftClose, Play, RefreshCcw, RotateCcw, Send, Share2, ShieldCheck, Smartphone, Sparkles, Square, WandSparkles, X } from "lucide-react";
import { composePreview } from "@/lib/runtime";
import type { AgentEvent, AgentPlan, AppQualityReport, GeneratedFiles, Project } from "@/lib/types";

type TimelineItem = { id: string; agent: string; title: string; detail: string; state: "working" | "done" | "error"; time: string };

const agentTone: Record<string, string> = { Iris: "iris", Bob: "bob", Alex: "alex", Ray: "ray" };

export function Workbench({ projectId }: { projectId: string }) {
  const router = useRouter();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const startedRef = useRef(false);
  const generatingRef = useRef(false);
  const generationControllerRef = useRef<AbortController | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [requestText, setRequestText] = useState("");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [livePlan, setLivePlan] = useState<AgentPlan | null>(null);
  const [liveQuality, setLiveQuality] = useState<AppQualityReport | null>(null);
  const [activeTab, setActiveTab] = useState<"preview" | "code">("preview");
  const [activeFile, setActiveFile] = useState<keyof GeneratedFiles>("index.html");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [previewError, setPreviewError] = useState("");
  const [notice, setNotice] = useState("");
  const [showVersions, setShowVersions] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const handleEvent = useCallback((event: AgentEvent) => {
    if (event.type === "status") {
      setTimeline((items) => [...items.filter((item) => !(item.agent === event.agent && item.state === "working")), { id: crypto.randomUUID(), agent: event.agent, title: event.title, detail: event.detail, state: event.state, time: nowTime() }]);
    } else if (event.type === "plan") {
      setLivePlan(event.plan);
    } else if (event.type === "file") {
      setTimeline((items) => [...items, { id: crypto.randomUUID(), agent: "Alex", title: `写入 ${event.path}`, detail: `${Math.max(1, Math.round(event.size / 1000))} KB · 已完成`, state: "done", time: nowTime() }]);
    } else if (event.type === "review") {
      setLiveQuality(event.report);
    } else if (event.type === "complete") {
      setProject(event.project);
      setLivePlan(event.project.plan);
      setLiveQuality(currentQuality(event.project));
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
    setGenerating(true);
    setPreviewError("");
    setTimeline([]);
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
      setTimeline((items) => [...items, { id: crypto.randomUUID(), agent: "Ray", title: "生成中断", detail: message, state: "error", time: nowTime() }]);
      setNotice(message);
    } finally {
      if (generationControllerRef.current === generationController) generationControllerRef.current = null;
      generatingRef.current = false;
      setGenerating(false);
    }
  }, [handleEvent, projectId]);

  const cancelCurrentGeneration = useCallback(async () => {
    generationControllerRef.current?.abort();
    try {
      const response = await fetch(`/api/projects/${projectId}/cancel`, { method: "POST", keepalive: true });
      if (!response.ok) throw new Error("取消请求失败");
    } catch {
      setNotice("本地请求已停止；服务端任务会由租约自动回收");
    }
  }, [projectId]);

  useEffect(() => {
    fetch(`/api/projects/${projectId}`).then(async (response) => {
      const data = await response.json() as { error?: string; project: Project };
      if (!response.ok) throw new Error(data.error || "项目不存在");
      setProject(data.project);
      setLivePlan(data.project.plan);
      setLiveQuality(currentQuality(data.project));
      return data.project as Project;
    }).then((value) => {
      if (value.versions.length === 0 && !startedRef.current) {
        startedRef.current = true;
        void runGenerate(value.prompt);
      }
    }).catch((cause) => setNotice(cause instanceof Error ? cause.message : "读取项目失败")).finally(() => setLoading(false));
  }, [projectId, runGenerate]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.data?.source !== "nucleus-preview") return;
      if (event.data.type === "error") setPreviewError(String(event.data.message || "预览运行出错"));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const srcDoc = useMemo(() => project ? composePreview(project.files) : "", [project]);

  async function restore(versionId: string) {
    const response = await fetch(`/api/projects/${projectId}/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ versionId }) });
    const data = await response.json() as { error?: string; project: Project };
    if (!response.ok) return setNotice(data.error || "恢复失败");
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

  if (loading || !project) return <div className="workbench-loading"><span className="brand-mark"><Boxes size={22} /></span><LoaderCircle className="spin" size={22} /><p>正在打开工作台…</p></div>;
  const latestRun = project.runs[0];

  return (
    <main className={`workbench ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <header className="workbench-topbar">
        <div className="topbar-left"><button className="icon-button" onClick={() => router.push("/")} aria-label="返回首页"><ArrowLeft size={18} /></button><Link className="brand compact" href="/"><span className="brand-mark"><Boxes size={17} /></span><span>Nucleus</span></Link><span className="top-divider" /><div className="project-title"><strong>{project.title}</strong><span className={`status-dot ${generating ? "busy" : ""}`} /> <small>{generating ? "生成中" : "已保存"}</small></div></div>
        <div className="topbar-actions"><button onClick={() => setShowVersions(true)}><History size={16} /> <span>版本</span><b>v{project.versions[0]?.versionNumber ?? 0}</b></button><button onClick={() => void download()}><Download size={16} /><span>下载</span></button>{project.slug && <a href={`/p/${project.slug}`} target="_blank" rel="noreferrer"><ExternalLink size={16} /><span>查看发布页</span></a>}<button className="primary-action" onClick={() => void publish()}><Share2 size={16} /><span>{project.slug ? "复制链接" : "发布"}</span></button></div>
      </header>

      <aside className="agent-panel">
        <div className="panel-heading"><div><span>智能体团队</span><small>{generating ? "正在协作" : "本轮记录"}</small></div><button className="icon-button" onClick={() => setSidebarOpen(false)} aria-label="收起侧栏"><PanelLeftClose size={17} /></button></div>
        <div className="agent-roster">{["Iris", "Bob", "Alex", "Ray"].map((agent) => <div key={agent} className={`agent-avatar ${agentTone[agent]}`}>{agent.slice(0, 1)}<span className={generating && timeline.at(-1)?.agent === agent ? "online" : ""} /></div>)}<div className="roster-copy"><strong>{generating ? `${timeline.at(-1)?.agent ?? "Iris"} 正在工作` : "4 位成员已就绪"}</strong><span>Planner · Builder · Reviewer</span></div></div>

        <div className="timeline">
          {timeline.length === 0 && !generating && <div className="timeline-empty"><Bot size={22} /><strong>等待新的修改</strong><p>在下方输入需求，团队会继续迭代当前应用。</p></div>}
          {timeline.map((item, index) => <div className={`timeline-item ${item.state}`} key={item.id}><div className="timeline-rail"><span className={`agent-avatar small ${agentTone[item.agent] ?? "ray"}`}>{item.agent.slice(0, 1)}</span>{index < timeline.length - 1 && <i />}</div><div className="timeline-content"><div><strong>{item.agent}</strong><time>{item.time}</time></div><h4>{item.title}{item.state === "working" && <LoaderCircle className="spin" size={13} />}{item.state === "done" && <Check size={13} />}{item.state === "error" && <CircleAlert size={13} />}</h4><p>{item.detail}</p></div></div>)}
        </div>

        {(livePlan || project.plan) && <div className="plan-card"><span><WandSparkles size={14} /> 当前计划</span><strong>{(livePlan || project.plan)?.summary}</strong><ul>{(livePlan || project.plan)?.features.slice(0, 4).map((feature) => <li key={feature}><Check size={11} />{feature}</li>)}</ul></div>}

        {liveQuality && <div className={`quality-card ${liveQuality.passed ? "passed" : "failed"}`}><header><span><ShieldCheck size={13} /> Ray 质量门</span><b>{liveQuality.grade}</b></header><div className="quality-score"><strong>{liveQuality.score}</strong><span>/100</span><i><em style={{ width: `${liveQuality.score}%` }} /></i></div><footer><span>{liveQuality.checks.filter((check) => check.severity === "pass").length}/{liveQuality.checks.length} 项通过</span><small>{liveQuality.checks.find((check) => check.severity !== "pass")?.label ?? "语法、安全、交互与体验均已验证"}</small></footer></div>}

        {latestRun && <details className={`run-audit-card ${latestRun.status}`}><summary><span><Activity size={13} /> 执行审计</span><b>{runStatusLabel(latestRun.status)}</b></summary><div className="run-metrics"><span><strong>{formatDuration(latestRun.durationMs)}</strong><small>总耗时</small></span><span><strong>{latestRun.usage.totalTokens || "—"}</strong><small>Tokens</small></span><span><strong>{latestRun.modelCalls}</strong><small>模型调用</small></span><span><strong>{latestRun.events.length}</strong><small>事件</small></span></div><ol>{latestRun.events.map((event) => <li key={event.id}><i className={event.state} /><div><strong>{event.agent} · {event.title}</strong><small>{event.durationMs === null ? event.phase : `${event.phase} · ${formatDuration(event.durationMs)}`}{event.usage.totalTokens ? ` · ${event.usage.totalTokens} tokens` : ""}</small></div></li>)}</ol><footer><code>{latestRun.id.slice(0, 8)}</code><span>{latestRun.model}{latestRun.repairCount ? ` · ${latestRun.repairCount} 次修复` : ""}</span></footer></details>}

        <form className="iteration-box" onSubmit={(event) => { event.preventDefault(); void runGenerate(requestText); }}><textarea value={requestText} onChange={(e) => setRequestText(e.target.value)} placeholder="告诉团队你想修改什么…" disabled={generating} /><div><span><MessageSquareText size={13} /> {generating ? "生成任务进行中" : "继续迭代"}</span>{generating ? <button type="button" onClick={() => void cancelCurrentGeneration()} aria-label="取消生成"><Square size={14} /></button> : <button disabled={requestText.trim().length < 3} aria-label="发送修改需求"><Send size={16} /></button>}</div></form>
      </aside>

      {!sidebarOpen && <button className="reopen-sidebar" onClick={() => setSidebarOpen(true)}><Bot size={18} /><span>智能体</span></button>}

      <section className="canvas-panel">
        <div className="canvas-toolbar"><div className="view-tabs"><button className={activeTab === "preview" ? "active" : ""} onClick={() => setActiveTab("preview")}><Play size={14} />预览</button><button className={activeTab === "code" ? "active" : ""} onClick={() => setActiveTab("code")}><Code2 size={14} />代码</button></div><div className="canvas-actions">{activeTab === "preview" && <div className="device-toggle"><button className={device === "desktop" ? "active" : ""} onClick={() => setDevice("desktop")} aria-label="桌面预览"><Monitor size={15} /></button><button className={device === "mobile" ? "active" : ""} onClick={() => setDevice("mobile")} aria-label="手机预览"><Smartphone size={15} /></button></div>}<button onClick={() => setPreviewError("")} aria-label="刷新"><RefreshCcw size={15} /></button><button onClick={() => iframeRef.current?.requestFullscreen()} aria-label="全屏"><Maximize2 size={15} /></button></div></div>

        {previewError && <div className="runtime-error"><CircleAlert size={16} /><div><strong>预览发现运行错误</strong><span>{previewError}</span></div><button onClick={() => void runGenerate(`请修复这个运行错误，并保持当前功能：${previewError}`)} disabled={generating}><Sparkles size={14} /> 让 Ray 修复</button><button className="icon-button" onClick={() => setPreviewError("")}><X size={14} /></button></div>}

        {activeTab === "preview" ? <div className={`preview-stage ${device}`}><div className="preview-browser"><div className="browser-bar"><span className="browser-dots"><i /><i /><i /></span><div><Globe2 size={12} /> nucleus.preview/{slugify(project.title)}</div><Laptop size={14} /></div><iframe ref={iframeRef} title={`${project.title} 预览`} sandbox="allow-scripts allow-forms allow-modals allow-popups" srcDoc={srcDoc} /></div></div> : <div className="code-workspace"><aside className="file-tree"><div><span>项目文件</span><small>3 files</small></div>{(Object.keys(project.files) as Array<keyof GeneratedFiles>).map((path) => <button key={path} className={activeFile === path ? "active" : ""} onClick={() => setActiveFile(path)}><FileCode2 size={15} /><span>{path}</span><small>{Math.max(1, Math.round(project.files[path].length / 1000))}k</small></button>)}</aside><section className="code-editor"><header><span>{activeFile}</span><button onClick={() => { void navigator.clipboard.writeText(project.files[activeFile]); setNotice("代码已复制"); }}><Copy size={14} />复制</button></header><pre><code>{project.files[activeFile]}</code></pre></section></div>}
      </section>

      {showVersions && <div className="drawer-backdrop"><button className="drawer-dismiss" onClick={() => setShowVersions(false)} aria-label="关闭版本历史" /><aside className="version-drawer"><header><div><span>版本历史</span><small>每次生成都会自动建立检查点</small></div><button className="icon-button" onClick={() => setShowVersions(false)}><X size={18} /></button></header><div className="version-list">{project.versions.map((version) => <article className={project.currentVersionId === version.id ? "current" : ""} key={version.id}><div className="version-number">v{version.versionNumber}</div><div><strong>{version.summary}</strong><span><Clock3 size={12} /> {new Date(version.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span><small>{version.model}{version.quality ? ` · Ray ${version.quality.score}/100` : ""}</small></div>{project.currentVersionId === version.id ? <b><Check size={12} />当前</b> : <button onClick={() => void restore(version.id)}><RotateCcw size={13} />恢复</button>}</article>)}</div></aside></div>}
      {notice && <div className="toast"><Check size={15} />{notice}</div>}
    </main>
  );
}

function nowTime() { return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); }
function slugify(value: string) { return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "") || "nucleus-app"; }
function currentQuality(project: Project): AppQualityReport | null { return project.versions.find((version) => version.id === project.currentVersionId)?.quality ?? project.versions[0]?.quality ?? null; }
function formatDuration(value: number | null) { return value === null ? "—" : value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`; }
function runStatusLabel(status: Project["runs"][number]["status"]) { return ({ running: "进行中", completed: "已完成", failed: "失败", cancelled: "已取消", rejected: "已拒绝" })[status]; }
