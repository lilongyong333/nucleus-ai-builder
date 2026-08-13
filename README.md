# Nucleus

> 描述一个想法，AI 智能体团队为你规划、构建并交付一个真正可运行的网页应用。

Nucleus 是一个面向非技术用户的 AI 应用生成器。游客可直接体验；登录后项目、版本和对话记忆会随账号跨设备保存。输入一句需求即可看到 Iris（需求）、Bob（架构）、Alex（开发）和 Ray（检查）协作完成规划、代码生成、预览和版本保存。

**在线体验：** https://www.llynb.cc

**复杂看板成品：** https://www.llynb.cc/p/app-0bd184

**Sites 备用地址：** https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site

**公开源码：** https://github.com/lilongyong333/nucleus-ai-builder

## 已实现功能

- 一句话创建 HTML / CSS / JavaScript 三文件应用
- OpenCode Go 真实调用：Iris 需求、Bob 架构、Alex 三文件开发、Ray 审查分别执行，规划/代码模型双向受控回退
- 完整 JSON/代码工件在 Provider 缺失流终止事件时可经结构验证安全救回；明确长度截断继续拒绝
- Iris/Bob/Ray Provider 或解析故障可形成带审计的保守确定性工件；Alex 真实代码与最终质量门不能跳过
- 单次请求超时、阶段预算与整轮调用/Token 总预算分离，最终尝试状态和真实错误写入审计
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
- 每应用物理 D1 Provisioner：生成后自动异步创建、Schema 摘要调和、租约回收、指数重试、分页迁移、Time Travel、延迟删除和审计
- 可选 R2 长期数据库归档：物理 D1 SQL Export、逻辑快照、对象保留期清理和归档错误证据
- GitHub App 安装/OAuth 绑定与短期 Installation Token；旧 PAT 默认禁用，只能显式开启兼容模式
- Stripe Checkout、Billing Portal、签名 Webhook、幂等事件、订阅权益降级、发票镜像与 Meter Event 导出
- 邮件/告警 Outbox、Resend/Sentry/Webhook 重试与去重、生产维护任务和可配置 SLO
- Runner 双重认证、五分钟 HMAC 防重放、终态不可重复提交，以及依赖投毒/元数据 SSRF/容器 Socket 防护
- 触屏 DOM 选择与移动端底部可视化编辑器；支持文字、尺寸、间距、Display 和 Grid 局部修改
- 240 个固定语义用例、多类型产品/安全 Eval、真实浏览器 E2E，以及支持多 Cookie 用户池和显式写场景的负载测试
- 贪吃蛇与中文打字速度测试拥有专项功能契约，阻止“视觉像成品但核心循环不可用”的静态假 Demo

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
OPENCODE_GO_MODEL=gpt-5.6-luna
OPENCODE_GO_FALLBACK_MODEL=glm-5.2
OPENCODE_GO_CODE_MODEL=glm-5.2
OPENCODE_GO_CODE_FALLBACK_MODEL=gpt-5.6-luna
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

密钥只在 Worker 服务端读取，不能添加 `NEXT_PUBLIC_` 前缀，也不能提交 `.env.local`。

## 验证

```bash
pnpm test
pnpm eval:product
pnpm test:e2e
pnpm lint
pnpm exec tsc --noEmit
pnpm exec drizzle-kit check
pnpm build
```

2026-08-13 当前发布门结果：Vitest 363/363、产品/安全 Eval 283/283、专项安全 17/17、Chromium E2E 11/11；TypeScript、ESLint、Migration 生成和 Vinext production build 通过。模型网关会按 OpenCode Go 模型选择 Responses API 或 Chat Completions，并统一审计流式状态与 Token 用量。生成应用在严格 opaque iframe 沙箱中通过有配额的宿主桥持久化 `localStorage`，刷新不再丢任务数据。只读压测实际运行 1,000 请求/40 并发，0 失败、P95 2162.62ms。该数据是本机开发 Worker 基线，不应外推为生产容量承诺。

浏览器 E2E 覆盖：项目创建、工作台、流式 Agent 结果、断线恢复、消息队列、账号项目库、v0 真实性、触屏 DOM 编辑，以及一条不 Mock API 的本地 D1 草稿创建/刷新恢复。真实付费模型生成和外部 Provider 验收需在配置相应密钥的 staging/生产环境单独执行。

## 核心数据流

```text
用户需求
  → 创建 Project / Message
  → Iris 需求工件 → Bob 架构/Runtime 工件
  → Alex 分别生成 index.html / styles.css / script.js 并逐文件保存断点
  → Ray 模型审查 + 确定性/应用类型质量门 → 有限修复
  → 每阶段主备模型、工件级救回、确定性降级与独立预算
  → 写入 Artifact / ModelAttempt / AgentEvent / GenerationRun 审计
  → 仅在质量门通过后写入 Version 全量快照
  → 注入 CSS / runtime / JavaScript
  → sandbox iframe 运行
  → ready / error / unhandledrejection 回传工作台
  → 浏览器断流时读取服务端状态并恢复结果
```

## 工程取舍

默认生成物仍是无构建步骤的浏览器三文件应用，但现在每个正式版本同时拥有 AppManifest、运行时 API、项目命名空间 Schema、Auth、日志与备份；生成提交后会自动登记并异步调和独立物理 D1。这样既保留秒级预览与 sandbox 安全边界，又让生成应用的数据在刷新和跨会话后真实存在。

Cloudflare Worker 本身不会执行模型生成的 shell 命令或任意 Docker。npm、pip、系统包、Node/Python/Java 容器由受限的外部 Runner Provider 执行；仓库已经实现任务、最小权限合同、双向签名、防重放、限额、回调和审计协议，但没有附带一个已经购买并在线运行的托管容器集群。默认数据库保持严格的每项目逻辑 D1 命名空间作为故障回退；配置 Cloudflare API Provider 后会自动创建独立物理 D1、增量 Migration、Time Travel 和可选 R2 长期归档。R2 独立归档也不等价于已经完成第二云厂商跨区域灾备。GitHub App、Stripe、邮件、物理 D1 与外部 Runner 未配置真实凭据时会显示 `configuration-required`，不会用假成功掩盖边界。

## 文档

- [完整文档中心](docs/README.md)
- [从零到上线：完整教学手册](docs/learning/README.md)
- [商业化加固与 Provider 落地 Runbook](docs/learning/19-commercial-hardening-and-provider-runbook.md)
- [引导式需求、实时代码工作台、严格沙箱持久化与真实生产 Eval](docs/learning/21-guided-intake-live-cockpit-and-production-eval.md)
- [架构与取舍](docs/DESIGN.md)
- [企业级开发、GitHub、部署与排障教学](docs/ENGINEERING-HANDBOOK.md)
- [www.llynb.cc 自定义域名与长期托管](docs/CUSTOM-DOMAIN-DEPLOYMENT.md)
- [同类第一梯队上限基准与真实 Demo](docs/UPPER-BOUND-BENCHMARK.md)
- [与 MetaGPT / Atoms 的差距分析与优化路线](docs/METAGPT-GAP-ANALYSIS.md)
- [开发进度与验收记录](docs/PROGRESS.md)
- [提交说明](docs/SUBMISSION.md)
- [可直接发送给 HR 的笔试说明 PDF](output/pdf/Nucleus-ROOT-Fullstack-Written-Test-Li-Longyong.pdf)
- [后续开发计划](docs/DEV-PLAN.md)
- [第三方说明](THIRD_PARTY_NOTICES.md)

## License

MIT
