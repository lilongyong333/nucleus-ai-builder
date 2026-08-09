# Nucleus

> 描述一个想法，AI 智能体团队为你规划、构建并交付一个真正可运行的网页应用。

Nucleus 是一个面向非技术用户的 AI 应用生成器。游客可直接体验；登录后项目、版本和对话记忆会随账号跨设备保存。输入一句需求即可看到 Iris（需求）、Bob（架构）、Alex（开发）和 Ray（检查）协作完成规划、代码生成、预览和版本保存。

**在线体验：** https://www.llynb.cc

**复杂看板成品：** https://www.llynb.cc/p/app-0bd184

**Sites 备用地址：** https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site

**公开源码：** https://github.com/lilongyong333/nucleus-ai-builder

## 已实现功能

- 一句话创建 HTML / CSS / JavaScript 三文件应用
- OpenCode Go 真实调用，默认 `glm-5.2`，失败时降级到 `qwen3.5-plus`
- Iris 使用确定性本地 SOP 产出结构化计划；正常新建只需一次代码模型调用
- 单次请求超时与整轮调用/Token/时间预算，最终实际模型写入审计
- 智能体工作时间线和结构化产品计划
- sandbox iframe 中的可交互实时预览、启动校验和运行错误回传
- 桌面 / 手机预览切换和源码查看
- 基于当前版本继续对话修改
- 运行错误回传，并可一键交给 Ray 修复
- Ray 质量门：9 项语法、安全、交互与体验检查，失败自动定向修复
- 可审计生成运行：持久化每轮 Agent 阶段、模型、耗时、Token、模型调用数、修复次数和最终状态
- 匿名会话工作区：项目列表、读取、生成、恢复和发布均按 HttpOnly 会话隔离
- 同项目生成租约与取消：并发请求返回 409，取消会尝试中止上游请求并可靠撤销旧任务落库权限
- Cloudflare D1 云端项目、消息和版本持久化
- Sign in with ChatGPT 账号、匿名项目迁移、跨设备项目中心和最近 100 条对话记忆
- 长任务心跳；浏览器断流后轮询服务端并自动恢复完成版本，仍可取消遗留任务
- 全量版本快照、质量评分持久化、历史版本恢复
- 公开发布页 `/p/[slug]` 固定到明确版本，后续草稿不会静默改变已发布内容
- ZIP 源码下载
- 游客直接体验，无登录门槛
- 公开生成接口按匿名指纹每小时限 8 次，避免套餐被刷
- 每个正式版本生成 AppManifest，并拥有独立 API 基路径、数据 Schema 与哈希化 Auth Session
- 生成应用通过 `window.nucleus.data` 使用 D1 持久化 CRUD、乐观并发控制、日志和备份恢复
- Race Mode 多代码模型并行候选、确定性评分、择优和候选审计
- 预览 DOM 元素选择、即时视觉 Patch 与正式多 Agent 局部改版
- Console/Runtime/云端浏览器证据自动写回，失败可原子领取并交给 Ray 修复
- 组织成员、RBAC、发布审批、Token/模型调用/数据库写入用量控制
- GitHub Iris/Bob/Alex/Ray 分支自动化与合并 Provider
- GitHub Actions Playwright 和外部 npm/pip/system/container Runner 协议；缺少凭据时明确显示 `configuration-required`

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
OPENCODE_GO_FALLBACK_MODEL=qwen3.5-plus
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

密钥只在 Worker 服务端读取，不能添加 `NEXT_PUBLIC_` 前缀，也不能提交 `.env.local`。

## 验证

```bash
pnpm test
pnpm test:e2e
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
  → 共享调用 / Token / 时间预算，主模型失败时受控降级
  → 解析并与当前版本增量合并
  → 写入 AgentEvent 审计轨迹与 GenerationRun 用量汇总
  → 写入 Version 全量快照
  → 注入 CSS / runtime / JavaScript
  → sandbox iframe 运行
  → ready / error / unhandledrejection 回传工作台
  → 浏览器断流时读取服务端状态并恢复结果
```

## 工程取舍

默认生成物仍是无构建步骤的浏览器三文件应用，但现在每个正式版本同时拥有 AppManifest、运行时 API、项目命名空间 Schema、Auth、日志与备份。这样既保留秒级预览与 sandbox 安全边界，又让生成应用的数据在刷新和跨会话后真实存在。

Cloudflare Worker 本身不会执行模型生成的 shell 命令或任意 Docker。npm、pip、系统包、Node/Python/Java 容器由受限的外部 Runner Provider 执行；仓库已经实现任务、权限、限额、回调和审计协议，但没有附带托管容器集群。D1 隔离是严格的每项目逻辑命名空间，不是每应用动态创建一个物理 D1 实例。外部 Provider 未配置时产品会显示 `configuration-required`，不会用假成功掩盖边界。

## 文档

- [完整文档中心](docs/README.md)
- [从零到上线：完整教学手册](docs/learning/README.md)
- [架构与取舍](docs/DESIGN.md)
- [企业级开发、GitHub、部署与排障教学](docs/ENGINEERING-HANDBOOK.md)
- [www.llynb.cc 自定义域名与长期托管](docs/CUSTOM-DOMAIN-DEPLOYMENT.md)
- [同类第一梯队上限基准与真实 Demo](docs/UPPER-BOUND-BENCHMARK.md)
- [与 MetaGPT / Atoms 的差距分析与优化路线](docs/METAGPT-GAP-ANALYSIS.md)
- [开发进度与验收记录](docs/PROGRESS.md)
- [提交说明](docs/SUBMISSION.md)
- [后续开发计划](docs/DEV-PLAN.md)
- [第三方说明](THIRD_PARTY_NOTICES.md)

## License

MIT
