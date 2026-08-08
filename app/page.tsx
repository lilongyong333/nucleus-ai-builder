"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Boxes, Clock3, Code2, Layers3, LoaderCircle, Plus, Sparkles } from "lucide-react";
import type { Project } from "@/lib/types";

const examples = [
  { label: "效率工具", title: "番茄钟待办", prompt: "做一个极简番茄钟待办应用，可以新增任务、完成任务、开始 25 分钟专注计时，并统计今天完成数量。", tone: "lime" },
  { label: "数据看板", title: "个人财务面板", prompt: "做一个个人财务看板，展示月度收入支出、预算进度和最近交易，支持新增一笔支出并实时更新统计。", tone: "orange" },
  { label: "团队协作", title: "轻量看板", prompt: "做一个有三列状态的项目看板，支持新建卡片、点击卡片在状态之间流转，并显示各列任务数量。", tone: "blue" },
  { label: "互动体验", title: "打字速度测试", prompt: "做一个漂亮的中文打字速度测试，随机显示一段文字，实时计算正确率和每分钟字数，完成后展示成绩。", tone: "violet" },
];

export default function Home() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/projects").then((r) => r.json() as Promise<{ projects?: Project[] }>).then((data) => setProjects(data.projects ?? [])).catch(() => undefined);
  }, []);

  async function createApp(value = prompt) {
    const clean = value.trim();
    if (clean.length < 3 || creating) return;
    setCreating(true);
    setError("");
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: clean }) });
      const data = await response.json() as { error?: string; project: Project };
      if (!response.ok) throw new Error(data.error || "创建失败");
      router.push(`/w/${data.project.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建失败，请稍后重试");
      setCreating(false);
    }
  }

  return (
    <main className="landing">
      <nav className="landing-nav">
        <Link className="brand" href="/"><span className="brand-mark"><Boxes size={18} /></span><span>Nucleus</span></Link>
        <div className="nav-center"><a href="#examples">灵感</a><a href="#how">工作方式</a></div>
        <a className="nav-cta" href="#create">开始构建 <ArrowRight size={15} /></a>
      </nav>

      <section className="hero" id="create">
        <div className="hero-orb orb-one" /><div className="hero-orb orb-two" />
        <div className="hero-kicker"><Sparkles size={14} /> 让一支 AI 团队，把想法变成产品</div>
        <h1>描述一个想法。<br /><span>看它真正运行。</span></h1>
        <p className="hero-copy">不需要从空白文件开始。Nucleus 会先理解需求，再规划、编写和检查，最后交付一个能点击、能使用、能继续修改的网页应用。</p>
        <div className="prompt-composer">
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void createApp(); }} placeholder="例如：做一个帮助我规划旅行预算的应用…" aria-label="描述你想创建的应用" />
          <div className="composer-footer"><span><Sparkles size={13} /> OpenCode Go · Kimi Code</span><button onClick={() => void createApp()} disabled={creating || prompt.trim().length < 3}>{creating ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}<span>开始构建</span></button></div>
        </div>
        {error && <p className="form-error">{error}</p>}
        <p className="composer-hint">按 Ctrl + Enter 提交 · 无需注册即可体验</p>
      </section>

      <section className="proof-strip" id="how">
        <div><span className="proof-icon iris"><Sparkles size={17} /></span><strong>Iris</strong><small>理解你真正要解决的问题</small></div>
        <span className="proof-line" />
        <div><span className="proof-icon bob"><Layers3 size={17} /></span><strong>Bob</strong><small>规划功能与交互结构</small></div>
        <span className="proof-line" />
        <div><span className="proof-icon alex"><Code2 size={17} /></span><strong>Alex</strong><small>生成可运行的完整代码</small></div>
        <span className="proof-line" />
        <div><span className="proof-icon ray"><Sparkles size={17} /></span><strong>Ray</strong><small>检查结果并保存版本</small></div>
      </section>

      <section className="examples" id="examples">
        <div className="section-heading"><div><span className="section-kicker">从一个具体场景开始</span><h2>不知道写什么？试试这些。</h2></div><p>每张卡片都会创建一个真实项目，你可以在工作台继续修改。</p></div>
        <div className="example-grid">
          {examples.map((example) => <button className={`example-card ${example.tone}`} key={example.title} onClick={() => { setPrompt(example.prompt); void createApp(example.prompt); }}><span>{example.label}</span><div className="example-art"><i /><i /><i /></div><h3>{example.title}</h3><p>{example.prompt}</p><b>用这个想法创建 <ArrowRight size={14} /></b></button>)}
        </div>
      </section>

      {projects.length > 0 && <section className="recent-projects"><div className="section-heading"><div><span className="section-kicker">保存在云端</span><h2>最近项目</h2></div></div><div className="recent-grid">{projects.slice(0, 6).map((project) => <button key={project.id} onClick={() => router.push(`/w/${project.id}`)}><span className="recent-icon"><Clock3 size={17} /></span><div><strong>{project.title}</strong><small>{project.status === "ready" ? `${project.versions.length} 个版本` : "等待继续"}</small></div><ArrowRight size={16} /></button>)}</div></section>}

      <footer><Link className="brand" href="/"><span className="brand-mark"><Boxes size={18} /></span><span>Nucleus</span></Link><p>Built for the ROOT full-stack challenge.</p><a href="#create"><Plus size={14} /> 创建新应用</a></footer>
    </main>
  );
}
