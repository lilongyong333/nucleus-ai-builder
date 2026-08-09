# Nucleus 全流程教学手册

这套文档不是一份“项目介绍”，而是一份可以照着学习、调试、演示和继续开发的工程手册。内容以仓库中的真实代码、真实 Git 提交和已上线环境为准。

## 先看结论

Nucleus 是一个 AI 网页应用生成器。用户输入一句需求后，系统会：

1. 创建项目；
2. 调用模型生成结构化产品计划；
3. 再调用模型生成 `index.html`、`styles.css`、`script.js`；
4. 通过 NDJSON 流把过程事件实时发给浏览器；
5. 将代码作为一个完整版本保存到 Cloudflare D1；
6. 在受限 iframe 中运行代码；
7. 支持继续修改、恢复旧版本、发布公开链接和下载 ZIP。

在线地址：<https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site>

源码地址：<https://github.com/lilongyong333/nucleus-ai-builder>

## 建议阅读顺序

| 顺序 | 文档 | 读完后能回答的问题 |
|---|---|---|
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

## 代码地图

```text
nucleus/
├─ app/
│  ├─ page.tsx                         首页
│  ├─ w/[id]/page.tsx                  工作台入口
│  ├─ p/[slug]/page.tsx                已发布应用页面
│  └─ api/
│     ├─ generate/route.ts              AI 生成流接口
│     └─ projects/...                   项目、恢复、发布接口
├─ components/
│  ├─ workbench.tsx                    工作台核心交互
│  └─ published-preview.tsx            公开页预览
├─ lib/
│  ├─ opencode.ts                      模型调用与 Prompt
│  ├─ parser.ts                        模型输出解析
│  ├─ runtime.ts                       文件校验和 iframe 组装
│  ├─ db.ts                            D1 数据访问
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
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

> 重要：已经公开粘贴过的密钥应当在提供商控制台撤销并新建。`.gitignore` 只能防止以后误提交，不能让已经泄露的密钥重新变安全。

## 你不需要一次看懂全部代码

先建立四个最小概念：

- React 组件：根据状态返回页面结构；
- API 路由：接收 HTTP 请求并返回 JSON 或数据流；
- 数据库：把项目和版本保存到云端；
- Git 提交：保存一次可追踪的代码变化。

掌握这四点后，再读模型协议和 iframe 运行时。它们是这个项目最有区分度、也最难的两部分。
