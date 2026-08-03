# Nucleus

> 由多智能体驱动的应用生成平台 —— 一句话描述想法，团队化的 AI 智能体协作产出可运行、可预览、可发布的网页应用。

**当前状态：🚧 开发中（S0 工程基线）**

---

## 这个项目想解决什么

同类工具（Lovable / bolt.new / v0）都有一个共同的失败模式：**生成的应用「没报错，但长歪了」**——
按钮溢出屏幕、文字重叠、对比度不足、移动端整个崩掉。运行时错误可以捕获，**视觉错误捕获不了**。

Nucleus 的两个核心命题：

| 命题 | 做法 |
|---|---|
| **让 Agent 能看见自己的产出** | 生成后自动双视口截图 → 作为图片回灌给视觉模型 → 自主发现视觉缺陷 → 修复 → 复检 |
| **让用户能看见 Agent 的决策** | 每个文件可溯源到「哪个智能体、第几轮、依据哪条架构决策、为什么」 |

---

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16（App Router）+ TypeScript |
| 样式 | Tailwind CSS v4 |
| 预览运行时 | esbuild-wasm + esm.sh + sandboxed iframe |
| 模型 | Claude（`claude-opus-5`），含视觉评审能力 |
| 数据 | Neon Postgres + Drizzle ORM |
| 部署 | Vercel |

---

## 本地启动

```bash
pnpm install
cp .env.example .env.local   # 填入下方环境变量
pnpm dev
```

### 环境变量

| 变量 | 用途 | 必需 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API，**仅服务端使用** | ✅ |
| `DATABASE_URL` | Neon Postgres 连接串 | ✅ |
| `AUTH_SECRET` | Auth.js 会话加密（`openssl rand -base64 32`） | ✅ |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | GitHub OAuth | 可选 |

> ⚠️ 所有密钥仅在服务端读取，**不得加 `NEXT_PUBLIC_` 前缀**。

---

## 项目结构

```
nucleus/
├─ app/
│  ├─ page.tsx              # 落地页
│  ├─ w/[projectId]/        # 工作台
│  ├─ p/[slug]/             # 公开发布页
│  └─ api/
│     ├─ agent/run/         # 主生成流（SSE）
│     └─ agent/heal/        # 自愈闭环
├─ components/
├─ lib/
│  ├─ agent/                # 工具定义、编排循环、事件协议
│  ├─ runtime/              # 预览运行时（部分复用上游，见 THIRD_PARTY_NOTICES.md）
│  ├─ store/                # 虚拟文件系统
│  └─ db/                   # Drizzle schema
└─ docs/                    # 设计文档、开发计划、进度记录
```

---

## 开源复用与自研范围

本项目**复用了** [Nutlope/llamacoder](https://github.com/Nutlope/llamacoder)（MIT）的浏览器内预览运行时，
完整声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

**本项目自研部分**：

- 多智能体编排（规划 → 架构 → 编码 → 质检）与流式事件协议
- 视觉自愈闭环（截图 → 视觉评审 → 修复 → 复检）
- 决策溯源系统
- 数据持久化、版本快照与回滚
- 认证、游客体验、公开发布页
- 全部 UI

> 选择复用而非重写运行时，是一个明确的工程取舍：把有限时间投入到差异化能力上，
> 而不是重新调试一个已被验证的模块。详见 [docs/DESIGN.md](./docs/DESIGN.md)。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/DESIGN.md](./docs/DESIGN.md) | 架构设计、模块详设、取舍清单、风险预案 |
| [docs/DEV-PLAN.md](./docs/DEV-PLAN.md) | 分阶段开发计划与验收标准 |
| [docs/PROGRESS.md](./docs/PROGRESS.md) | 逐阶段开发记录（做了什么、为什么、怎么验证） |

---

## License

MIT —— 见 [LICENSE](./LICENSE)
