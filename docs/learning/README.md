# Nucleus 全流程教学手册

这套文档不是一份“项目介绍”，而是一份可以照着学习、调试、演示、从零复现和继续开发的工程手册。内容以仓库中的真实代码、真实 Git 提交和已上线环境为准。

> **当前生产运行时代码基线：** commit `feccdf10ce462a94b070ae629241cb3110dd4aa4`、Sites production version 16、30 个 Vitest、4 个 Chromium E2E。教学文档提交可以晚于运行时提交。旧版 `docs/learning` 曾停留在独立分支 `agent/teaching-guide`，本次已恢复并升级到账号、记忆、质量门、模型预算、断流恢复和真实生产基准全部落地后的版本。

## 先看结论

Nucleus 是一个 AI 网页应用生成器。用户输入一句需求后，系统会：

1. 解析游客 Cookie 或 Sites 注入的 ChatGPT 登录身份；
2. 创建归属于当前 owner 的项目和第一条对话；
3. 获取同项目单写者租约并检查小时额度；
4. Iris 用本地确定性 SOP 生成结构化产品计划，0 Token、0 模型调用；
5. Alex 经主备模型网关生成 `index.html`、`styles.css`、`script.js`；
6. Ray 做 9 项确定性检查，必要时最多一次定向修复；
7. 通过 NDJSON 把真实 AgentEvent、质量和完成结果发送给浏览器；
8. 将代码、Version、GenerationRun、AgentEvent 和消息保存到 Cloudflare D1；
9. 在受限 iframe 中运行并回报 `ready/error/unhandledrejection`；
10. 支持断流恢复、取消、继续修改、恢复旧版本、固定版本发布和 ZIP 下载。

自定义域名：<https://www.llynb.cc>

Sites 备用地址：<https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site>

源码地址：<https://github.com/lilongyong333/nucleus-ai-builder>

## 建议阅读顺序

| 顺序 | 文档 | 读完后能回答的问题 |
|---|---|---|
| 0 | [真实施工日志](00-how-we-got-here.md) | 这几个小时到底改了什么，每个故障如何推动下一轮 |
| 1 | [需求拆解与范围](01-requirements-and-scope.md) | 笔试到底要交什么，为什么不做完整 Atoms 克隆 |
| 2 | [系统架构](02-system-architecture.md) | 请求如何穿过浏览器、Worker、模型和数据库 |
| 3 | [前端与工作台](03-frontend-workbench.md) | React 页面、状态、流式 UI 是怎么工作的 |
| 4 | [AI 生成链路](04-ai-generation-pipeline.md) | Prompt、模型协议、重试、漏文件修复怎么实现 |
| 5 | [预览运行时与安全](05-preview-runtime-and-security.md) | 三个文件如何在 iframe 里真正运行 |
| 6 | [API、数据库与版本](06-api-database-and-versioning.md) | D1 表、CRUD、快照、发布和限流怎么实现 |
| 7 | [测试、排错与质量](07-testing-debugging-and-quality.md) | 实际遇到过哪些坑，怎么定位，怎么验收 |
| 8 | [Git 与 GitHub](08-git-and-github.md) | 本地代码如何变成公开仓库，分支和 PR 是什么 |
| 9 | [部署与线上运维](09-deployment-and-operations.md) | 网页为什么能被公网访问，密钥和 D1 放在哪里 |
| 10 | [企业开发流程](10-enterprise-development-workflow.md) | 正常公司如何从需求走到生产，当前项目差什么 |
| 11 | [继续开发练习](11-learning-path-and-exercises.md) | 零基础按什么顺序改代码，如何避免越改越乱 |
| 12 | [演示、答辩与术语](12-demo-interview-and-glossary.md) | 怎么讲项目，面试官追问时如何回答 |
| 13 | [从零到生产落地手册](13-zero-to-production-runbook.md) | 怎样克隆运行、按提交重建、上 GitHub、配 D1/模型并部署验收 |
| 14 | [自定义域名与长期托管](../CUSTOM-DOMAIN-DEPLOYMENT.md) | 为什么选择 Sites 而非 Railway，DNS、证书、验收和回滚如何完成 |

如果你现在只想“照着做出来”，先读 00、13、07、09 和自定义域名文档；如果你想真正理解代码，再按 01–12 顺序阅读。

## 代码地图

```text
nucleus/
├─ app/
│  ├─ page.tsx                         首页
│  ├─ account/page.tsx                 登录账号项目中心
│  ├─ w/[id]/page.tsx                  工作台入口
│  ├─ p/[slug]/page.tsx                已发布应用页面
│  └─ api/
│     ├─ generate/route.ts              AI 生成流接口
│     ├─ session/route.ts               当前登录/游客身份
│     └─ projects/...                   项目、恢复、发布接口
├─ components/
│  ├─ workbench.tsx                    工作台核心交互
│  ├─ account-dashboard.tsx             项目与成品详细链接
│  └─ published-preview.tsx            公开页预览
├─ lib/
│  ├─ identity.ts / session.ts          登录身份、游客 Cookie、项目迁移
│  ├─ planner.ts                        确定性 Iris SOP
│  ├─ model-gateway.ts                  主备、超时、取消与共享预算
│  ├─ opencode.ts                       Alex 构建与 Ray 定向修复
│  ├─ parser.ts                        模型输出解析
│  ├─ quality.ts                       Acorn + 9 项 Ray 质量门
│  ├─ runtime.ts                       iframe 组装、storage shim、启动/错误桥
│  ├─ db.ts                            D1 所有权、租约、版本、审计与限流
│  └─ types.ts                         前后端共享类型
├─ db/schema.ts                        Drizzle 数据模型
├─ drizzle/                            SQL migration
├─ worker/index.ts                     Cloudflare Worker 入口
├─ vite.config.ts                      本地/生产构建配置
├─ build/sites-vite-plugin.ts          部署产物打包补充
└─ .openai/hosting.json                Sites 项目和资源绑定
```

## 本地学习环境

要求：Node.js 22.13+、pnpm 11、Git。GitHub 发布还需要 GitHub CLI。

```powershell
cd C:\Users\Windows\Desktop\demo\nucleus
pnpm install
Copy-Item .env.example .env.local
pnpm dev
```

`.env.local` 中只在本机填写密钥。不要在截图、文档、代码、Issue、PR 或聊天记录里展示真实值。

```dotenv
OPENCODE_GO_API_KEY=你的新密钥
OPENCODE_GO_BASE_URL=https://opencode.ai/zen/go/v1
OPENCODE_GO_MODEL=glm-5.2
OPENCODE_GO_FALLBACK_MODEL=qwen3.5-plus
OPENCODE_GO_REQUEST_TIMEOUT_MS=55000
OPENCODE_GO_MAX_MODEL_CALLS=8
OPENCODE_GO_MAX_TOTAL_TOKENS=50000
OPENCODE_GO_MAX_DURATION_MS=240000
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

> 重要：已经公开粘贴过的密钥应当在提供商控制台撤销并新建。`.gitignore` 只能防止以后误提交，不能让已经泄露的密钥重新变安全。

## 你不需要一次看懂全部代码

先建立四个最小概念：

- React 组件：根据状态返回页面结构；
- API 路由：接收 HTTP 请求并返回 JSON 或数据流；
- 数据库：把项目和版本保存到云端；
- Git 提交：保存一次可追踪的代码变化。

掌握这四点后，再读身份/所有权、模型协议、预算、质量门和 iframe 运行时。它们是这个项目最有区分度、也最容易在真实生产中出错的部分。

## 当前可直接核对的证据

- 在线站点：<https://www.llynb.cc>
- Sites 备用地址：<https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site>
- GitHub PR：<https://github.com/lilongyong333/nucleus-ai-builder/pull/2>
- 复杂看板：21 秒、6,293 Tokens、1 次模型调用、11 事件、Ray 100/A；
- 首页四个固定成品链接均返回 200；
- Sign in with ChatGPT 后，账号中心展示项目、版本、对话、工作台链接和公开成品链接；
- `pnpm test` 为 30/30，`pnpm test:e2e` 为 4/4，CI 在 Linux + Chromium 通过。
