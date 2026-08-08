# Nucleus

> 描述一个想法，AI 智能体团队为你规划、构建并交付一个真正可运行的网页应用。

Nucleus 是一个面向非技术用户的 AI 应用生成器。用户无需注册，输入一句需求即可看到 Iris（需求）、Bob（架构）、Alex（开发）和 Ray（检查）协作完成规划、代码生成、预览和版本保存。

**在线体验：** https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site

**公开源码：** https://github.com/lilongyong333/nucleus-ai-builder

## 已实现功能

- 一句话创建 HTML / CSS / JavaScript 三文件应用
- OpenCode Go 模型真实调用，默认使用 `glm-5.2`
- 智能体工作时间线和结构化产品计划
- sandbox iframe 中的可交互实时预览
- 桌面 / 手机预览切换和源码查看
- 基于当前版本继续对话修改
- 运行错误回传，并可一键交给 Ray 修复
- Cloudflare D1 云端项目、消息和版本持久化
- 全量版本快照、历史版本恢复
- 公开发布页 `/p/[slug]`
- ZIP 源码下载
- 游客直接体验，无登录门槛
- 公开生成接口按匿名指纹每小时限 8 次，避免套餐被刷

## 技术栈

| 层 | 实现 |
|---|---|
| 应用 | React 19 + Vinext App Router + TypeScript |
| 样式 | 原生 CSS，响应式工作台 |
| AI | OpenCode Go 的 OpenAI-compatible API |
| 数据 | Cloudflare D1 + SQLite schema / migrations |
| 预览 | 三文件虚拟项目 + sandboxed iframe + runtime bridge |
| 部署 | OpenAI Sites / Cloudflare Worker |

## 本地运行

环境要求：Node.js 22.13+、pnpm 11。

```bash
pnpm install
copy .env.example .env.local
pnpm dev
```

在 `.env.local` 中配置：

```dotenv
OPENCODE_GO_API_KEY=
OPENCODE_GO_BASE_URL=https://opencode.ai/zen/go/v1
OPENCODE_GO_MODEL=glm-5.2
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

密钥只在 Worker 服务端读取，不能添加 `NEXT_PUBLIC_` 前缀，也不能提交 `.env.local`。

## 验证

```bash
pnpm test
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

真实端到端验收还覆盖：创建项目、AI 生成 v1、继续修改生成 v2、恢复 v1/v2、发布公开页和生成代码语法检查；同一条生成链路已在正式线上环境再次跑通。

## 核心数据流

```text
用户需求
  → 创建 Project / Message
  → Iris 生成结构化计划
  → Alex 生成带 path 的三个代码块
  → 解析并与当前版本增量合并
  → 写入 Version 全量快照
  → 注入 CSS / runtime / JavaScript
  → sandbox iframe 运行
  → error / unhandledrejection 回传工作台
```

## 工程取舍

本次交付把生成物限制为无构建步骤的前端三文件应用。相比在演示环境里启动任意 Node 容器，这个边界明显降低了冷启动、依赖安装和恶意代码风险，同时仍能覆盖表单、看板、计时器、数据面板和小游戏等高频场景。

当前不支持生成后端、安装任意 npm 包或执行服务器代码。这是有意识的 MVP 范围，不是把静态截图当成功能。

## 文档

- [架构与取舍](docs/DESIGN.md)
- [开发进度与验收记录](docs/PROGRESS.md)
- [提交说明](docs/SUBMISSION.md)
- [后续开发计划](docs/DEV-PLAN.md)
- [第三方说明](THIRD_PARTY_NOTICES.md)

## License

MIT
