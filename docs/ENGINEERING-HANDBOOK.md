# Nucleus 企业级开发与部署教学手册

这份文档面向“能使用电脑和命令行，但不一定看得懂全部前端代码”的读者。目标不是让你背代码，而是让你能解释：产品怎么拆、数据怎么流、为什么安全、GitHub 为什么这样用、线上页面怎么部署、出现故障怎么判断。

## 1. 先认识 CLI、IDE 和浏览器

- **CLI（命令行界面）**：在终端里输入命令，例如 `pnpm test`、`git status`。适合安装依赖、运行测试、Git 和部署自动化。
- **IDE（集成开发环境）**：例如 VS Code。它把文件树、编辑器、代码提示、调试器和终端放在一个窗口里。
- **浏览器**：最终用户使用产品的地方，也是 E2E 验收真实交互的地方。
- **GitHub**：远程保存代码、代码评审、CI 和协作的中心，不等于部署平台。
- **Sites / Cloudflare Worker**：真正运行 Nucleus 服务端和网页的生产平台。

日常工作通常是：IDE 看和改代码，IDE 内置终端或独立 CLI 跑命令，GitHub 做评审与 CI，浏览器验收生产结果。

## 2. 一句话架构

Nucleus 是一个 React/Vinext 全栈应用：浏览器负责输入需求、展示 Agent 过程和运行生成物；Cloudflare Worker 负责身份、模型调用和业务规则；D1 负责项目、对话、版本与审计；OpenCode Go 提供模型；Sites 负责生产部署。

```text
Browser
  ├─ 首页：创建项目 / 最近项目 / 登录
  ├─ 工作台：Agent 时间线 / 预览 / 代码 / 版本 / 审计
  ├─ 账号中心：跨设备项目与详细链接
  └─ sandbox iframe：只运行生成的 HTML/CSS/JS
       │
       ▼
Cloudflare Worker API
  ├─ Identity：ChatGPT 登录或匿名 HttpOnly 会话
  ├─ Project service：所有权 / 限流 / 生成租约 / 版本 / 发布
  ├─ Model gateway：超时 / 主备切换 / 调用与 Token 预算
  └─ Quality gate：语法 / 安全 / 交互 / 响应式 / 可访问性
       │
       ├─ OpenCode Go
       └─ Cloudflare D1
```

## 3. 目录怎么读

| 目录/文件 | 作用 | 初学者先看什么 |
|---|---|---|
| `app/page.tsx` | 首页、登录入口、创建项目和最近项目 | 看 UI 文案与 `createApp` |
| `components/workbench.tsx` | 工作台主交互、读取 NDJSON、断流恢复、预览和版本 | 先看 `runGenerate`，再看 JSX |
| `app/api/generate/route.ts` | 生成主链路、租约、Agent 事件、流式响应 | 按 `try` 中的 Iris → Bob → Alex → Ray 阅读 |
| `lib/opencode.ts` | 模型提示词、规划、代码生成、定向修复 | 看 `createPlan` 和 `buildApp` |
| `lib/model-gateway.ts` | 超时、主备模型、预算与取消 | 看 `requestChat` 的模型循环 |
| `lib/quality.ts` | Ray 的 9 项确定性检查 | 看 `reviewGeneratedApp` |
| `lib/runtime.ts` | 三文件组装、沙箱错误桥、启动回报 | 看 `composePreview` |
| `lib/identity.ts` | 登录身份、匿名会话、项目迁移 | 看 `resolveWorkspaceIdentity` |
| `lib/db.ts` | D1 schema 和所有数据操作 | 先看导出的函数，不必先读 SQL 细节 |
| `e2e/workbench.spec.ts` | 从用户视角验证主路径 | 这是理解产品行为的最快入口 |
| `.github/workflows/ci.yml` | GitHub 自动验证 | 看每次 PR 必须通过什么 |
| `.openai/hosting.json` | Sites 项目标识与 D1 绑定 | 不能放 API Key |

建议阅读顺序：E2E 测试 → API 路由 → 工作台 → 数据库 → 模型网关 → 质量门。

## 4. 一次生成到底发生什么

### 4.1 创建项目

首页调用 `POST /api/projects`。服务端先解析身份：

- 已登录：使用稳定的 `chatgpt:<userId>` 作为 owner；
- 未登录：签发随机 HttpOnly visitor cookie；
- 第一次登录：把当前 visitor 名下项目迁移到账号 owner。

D1 写入 `projects` 和第一条用户 `messages`，然后返回工作台链接 `/w/<project-id>`。

### 4.2 获取生成租约

工作台调用 `POST /api/generate`。服务端原子地把项目改为 `generating` 并写入随机 `generation_id`。

这个 ID 是“单写者租约”：

- 同一项目第二个生成请求得到 409；
- 完成、失败、取消只能修改持有同一 ID 的任务；
- 旧请求即使晚到，也不能覆盖新版本；
- 超过 10 分钟的遗留租约可以被新任务回收。

### 4.3 建立共享模型预算

一轮生成只创建一个 `ModelBudget`，构建、补文件和 Ray 修复共同消耗：

```dotenv
OPENCODE_GO_MAX_MODEL_CALLS=8
OPENCODE_GO_MAX_TOTAL_TOKENS=50000
OPENCODE_GO_MAX_DURATION_MS=240000
OPENCODE_GO_REQUEST_TIMEOUT_MS=55000
```

默认主模型是 `qwen3.5-plus`，备用是 `glm-5.2`。以下情况会进入备用模型：

- 5xx 或模型特定错误；
- 网络错误；
- 单次请求超时；
- 连续两次空回复。

401 和 429 不自动切换，因为密钥错误和整体限流通常不是换模型能解决的。用户取消会直接传播 AbortSignal，不再调用备用模型。

### 4.4 Iris 规划

Iris 把需求变成固定结构：应用名、摘要、3-5 个功能和视觉方向。这是后续可审查工件，不是只显示一段“正在思考”。该步骤使用本地确定性 SOP，不调用模型：可预测、毫秒级、零 Token，并让正常新建应用从两次模型请求缩短为一次。真正需要创造性推理的代码构建和定向修复才使用模型预算。

### 4.5 Alex 构建

Alex 输出一个摘要和三个带路径代码块：

```text
index.html
styles.css
script.js
```

不用大 JSON 的原因是长代码中的引号、换行和截断很容易破坏 JSON。继续修改时允许只返回变化文件，解析器与当前版本合并。

### 4.6 Ray 质量门

Ray 对生成物做 9 项确定性检查：JavaScript 语法、危险运行节点、真实交互、语义 HTML、viewport、响应式 CSS、表单可访问名称、键盘焦点、自包含交付。

语法、安全或真实交互失败会阻止保存；系统把结构化问题交给模型做一次定向修复，再重新跑全部检查。只有通过门槛的文件能成为版本。

### 4.7 保存与推流

服务端把以下内容写进 D1：

- `versions`：完整三文件快照、模型、摘要和质量报告；
- `messages`：助手摘要，形成项目对话记忆；
- `generation_runs`：状态、耗时、Token、调用数、修复数和版本；
- `agent_events`：每个 Agent 阶段的有序事件。

浏览器同时读取 NDJSON 流。长模型阶段每 8 秒写入透明心跳；如果浏览器仍断流，工作台读取项目状态并轮询，后台完成后自动恢复结果。重新打开正在生成的项目不会再次提交生成请求。

## 5. 为什么预览不是“直接把代码塞进主页面”

生成代码是不可信输入。Nucleus 使用没有 `allow-same-origin` 的 sandbox iframe：

```text
allow-scripts allow-forms allow-modals allow-popups
```

生成代码不能读取 Nucleus 父页面数据。运行时还会：

- 转义 `</script>` 和 `</style>`，防止提前闭合；
- 捕获 `error` 和 `unhandledrejection`；
- 启动成功后回报 `ready`，工作台显示“启动校验通过”；
- opaque origin 无法用 localStorage 时提供内存兼容层；
- 发现错误时允许把错误文本交给 Ray 继续修复。

“启动校验通过”只证明页面无启动异常，不等于所有业务路径已自动点击。完整交付还要结合 Ray 静态门、Playwright 回归和人工 Demo 操作。

## 6. 账号、匿名访问和对话记忆

Nucleus 同时支持低门槛体验与跨设备账号：

1. 游客可直接创建项目，数据按随机 HttpOnly cookie 隔离；
2. 登录使用 Sites 提供的 Sign in with ChatGPT，不自己保存密码；
3. Worker 只信任平台注入的认证请求头，不信任浏览器随意提交的 user ID；
4. 登录后，当前匿名 owner 的项目一次性迁移到稳定账号 owner；
5. 项目详情最多返回最近 100 条对话、10 次运行和 200 个事件；
6. 账号中心给出工作台详细链接和公开成品链接。

退出登录不会删除项目；再次用同一账号登录可跨设备读取。公开页只返回发布版本，不返回私有对话与执行审计。

## 7. 数据库表为什么这样分

| 表 | 解决的问题 |
|---|---|
| `projects` | 当前工作区状态、owner、生成租约、当前/已发布版本 |
| `messages` | 用户需求与助手摘要，形成可见记忆 |
| `versions` | 每轮完整可恢复快照 |
| `generation_runs` | 一轮生成的总账和终态 |
| `agent_events` | 每个阶段的可审计明细 |
| `generation_limits` | 每小时匿名指纹配额 |

版本使用全量快照，不使用 diff。三文件应用通常只有几十 KB，全量快照更容易保证恢复正确，也更适合短时笔试解释。

`current_version_id` 与 `published_version_id` 分开：继续修改只改变当前版本；公开链接在再次点击发布前保持不变，避免线上内容静默漂移。

## 8. 本地开发

### 8.1 安装与配置

```powershell
pnpm install
Copy-Item .env.example .env.local
pnpm dev
```

在 `.env.local` 填入服务端 API Key。永远不要加 `NEXT_PUBLIC_` 前缀，也不要提交 `.env.local`。

### 8.2 每次提交前的质量命令

```powershell
pnpm test
pnpm test:e2e
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

它们分别回答：逻辑函数是否正确、用户主路径是否正确、代码规范是否正确、类型是否正确、生产包是否能构建。

## 9. 正常企业 Git/GitHub 流程

### 9.1 不直接改 main

```powershell
git switch -c agent/metagpt-quality-gate
```

一个分支对应一个可评审目标。先 `git status` 看范围，再提交相关文件：

```powershell
git add <files>
git commit -m "feat: add durable signed-in workspaces"
git push -u origin agent/metagpt-quality-gate
```

### 9.2 原子提交

本项目把账号、测试、模型预算、预览校验和断流恢复拆成独立提交。好处是：

- 评审人能理解每一步；
- CI 失败时容易定位；
- 某个改动有问题时可以单独回退；
- PR 不会变成一个无法解释的大代码包。

### 9.3 Pull Request

PR 描述应包含：问题、方案、风险、测试证据、线上验收和已知限制。Draft PR 表示仍在迭代，不代表代码可以跳过 CI。

GitHub Actions 在 Linux + Chromium 上重新执行测试、Lint、类型、构建和 E2E。它和本地结果互相补充：本地快，CI 证明在干净环境也能通过。

## 10. 网页端怎么部署

Nucleus 不是把 GitHub 页面当服务器，而是使用 Sites：

1. `pnpm build` 生成 Cloudflare Worker 兼容的 `dist`；
2. 把已经验证并推送的精确 Git commit 同构建包绑定成一个 Sites version；
3. `.openai/hosting.json` 只保存 Sites project ID 和 D1 逻辑绑定；
4. API Key 通过 Sites 环境变量管理，不写进 Git；
5. 部署一个已保存 version 到生产；
6. 轮询部署状态，成功后用固定网址验收首页、API、登录、生成、发布页。

“源码提交”和“生产版本”必须是同一 commit，避免 GitHub 展示 A、线上运行 B。

数据库 migration 会随构建包发布。运行时代码仍使用幂等 `CREATE TABLE IF NOT EXISTS`，让旧环境升级更稳，但正式团队仍应把 migration 当可审查工件。

## 11. 运维排障手册

### 现象：生成按钮一直转

1. 看顶栏是“生成中”还是“生成失败”；
2. 展开执行审计，看 run 状态、模型、调用数和错误；
3. 若显示“连接恢复中”，说明浏览器流断开但服务端仍工作，等待自动同步或点击取消；
4. 超过总预算仍不结束，取消并检查供应商网络、Worker 日志和遗留租约。

### 现象：另一个浏览器打不开项目

- 未登录的匿名项目只属于原 visitor cookie；
- 在原浏览器登录后项目会迁移到账号；
- 另一个设备用同一 ChatGPT 账号登录，再从账号中心打开。

### 现象：公开页不是最新版本

这是固定版本发布设计。回到工作台再次点击“发布”，才会把 `published_version_id` 更新为当前版本。

### 现象：模型 401/429

- 401：API Key 无效或过期，立即轮换；
- 429：套餐或频率限制，等待或升级配额；
- 这两类错误不会通过换备用模型掩盖。

### 现象：Ray 不让保存

展开质量问题，看是语法、安全、交互还是体验检查。系统只自动修复一次，防止无限模型循环和不可控成本。

## 12. 面试时怎么讲

用 60-90 秒只讲一条证据链：

1. 首页登录并展示账号项目中心；
2. 输入一个具体需求；
3. 展示 Iris 计划、Alex 文件和 Ray 质量门；
4. 在预览里做一个新增/筛选/计时等真实操作；
5. 展开执行审计，解释耗时、Token、模型调用和运行 ID；
6. 继续修改，展示对话记忆和版本恢复；
7. 发布并打开固定版本公开链接；
8. 最后说明安全边界和当前不做任意后端执行的原因。

不要说“复刻了 MetaGPT”或“肯定超过 90% 候选人”。更专业的说法是：研究了 MetaGPT 的 SOP、预算与质量闭环，按 Worker 运行边界独立实现，并用测试和生产证据证明关键链路。

## 13. 许可证与密钥

MetaGPT、LlamaCoder 和 Acorn 的参考范围写在 `THIRD_PARTY_NOTICES.md`。MetaGPT 学习副本在仓库外，没有把其 Python 源码复制到 Nucleus。

对话里曾经暴露过 API Key。即使 Git 历史和仓库都没有该密钥，也应在提交面试前到供应商控制台轮换旧 Key，并把新 Key 只写入本地 `.env.local` 和 Sites secret。
