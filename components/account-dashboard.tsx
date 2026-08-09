"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Boxes, Clock3, Copy, ExternalLink, LogOut, MessageSquareText, Plus, UserRound } from "lucide-react";
import type { Project } from "@/lib/types";

export function AccountDashboard({ origin, user }: { origin: string; user: { displayName: string; email: string } }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/projects")
      .then((response) => response.json() as Promise<{ projects?: Project[] }>)
      .then((data) => setProjects(data.projects ?? []))
      .finally(() => setLoading(false));
  }, []);

  async function copy(path: string, label: string) {
    await navigator.clipboard.writeText(`${origin}${path}`).catch(() => undefined);
    setNotice(`${label}已复制`);
    window.setTimeout(() => setNotice(""), 2600);
  }

  return <main className="account-page">
    <nav className="account-nav"><Link className="brand" href="/"><span className="brand-mark"><Boxes size={18} /></span><span>Nucleus</span></Link><div><Link href="/"><Plus size={15} />新建应用</Link><a href="/signout-with-chatgpt?return_to=%2F"><LogOut size={15} />退出登录</a></div></nav>
    <section className="account-hero"><div className="account-avatar"><UserRound size={25} /></div><div><span>账号工作区</span><h1>{user.displayName}</h1><p>{user.email} · 项目、版本和对话记忆会跨设备保存在云端。</p></div></section>
    <section className="account-content"><header><div><span>PROJECT LIBRARY</span><h2>我的项目与成品链接</h2></div><b>{projects.length} 个项目</b></header>
      {loading ? <div className="account-empty">正在读取云端项目…</div> : projects.length === 0 ? <div className="account-empty"><MessageSquareText size={28} /><strong>还没有项目</strong><p>创建第一个应用后，需求对话、版本和发布链接都会出现在这里。</p><Link href="/">开始创建 <ArrowRight size={15} /></Link></div> : <div className="account-projects">{projects.map((project) => {
        const workbenchPath = `/w/${project.id}`;
        const publicPath = project.slug ? `/p/${project.slug}` : null;
        return <article key={project.id}><header><span className={`account-status ${project.status}`}>{statusLabel(project.status)}</span><time><Clock3 size={12} />{new Date(project.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></header><h3>{project.title}</h3><p>{project.prompt}</p><div className="account-stats"><span><b>{project.versions.length}</b>版本</span><span><b>{project.currentVersionId ? "已生成" : "草稿"}</b>状态</span><span><b>{project.slug ? "已发布" : "未发布"}</b>成品</span></div><div className="account-links"><div><span>工作台详细链接</span><code>{origin}{workbenchPath}</code><button onClick={() => void copy(workbenchPath, "工作台链接")} aria-label="复制工作台链接"><Copy size={13} /></button></div>{publicPath ? <div><span>公开成品链接</span><code>{origin}{publicPath}</code><button onClick={() => void copy(publicPath, "成品链接")} aria-label="复制成品链接"><Copy size={13} /></button></div> : <div className="unpublished"><span>公开成品链接</span><small>进入工作台并点击“发布”后生成</small></div>}</div><footer><Link href={workbenchPath}>打开工作台 <ArrowRight size={14} /></Link>{publicPath && <a href={publicPath} target="_blank" rel="noreferrer">查看成品 <ExternalLink size={14} /></a>}</footer></article>;
      })}</div>}
    </section>
    {notice && <div className="toast">{notice}</div>}
  </main>;
}

function statusLabel(status: Project["status"]) {
  return ({ draft: "草稿", generating: "生成中", ready: "可用", error: "需重试" })[status];
}
