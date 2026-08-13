# 13. 从零到当前生产版本：可照做的落地手册

> 适用的生产运行时代码基线：commit `feccdf10ce462a94b070ae629241cb3110dd4aa4`、Node 22.13+、pnpm 11.5、Windows PowerShell。教学文档提交可以晚于运行时提交。真实密钥绝不能复制进本手册、Git 或聊天。

本章回答两个不同问题：

1. **我怎样最快把当前项目在自己的电脑跑起来？**——克隆和复现；
2. **如果不把最终代码当黑盒，我怎样从空项目逐步做到这个架构？**——按里程碑重建。

不要混淆二者。交作业应复现当前稳定版本；学习时再从历史提交逐层拆开。

---

## A. 30 分钟复现当前项目

## A1. 准备工具

需要：

- Git；
- Node.js 22.13 或更高；
- pnpm 11.5；
- 一个有效的 OpenCode Go Key；
- 发布 GitHub 时需要 GitHub CLI `gh`；
- 发布 Sites 时需要 Codex 桌面版的 Sites 能力和有权限的工作区。

检查：

```powershell
git --version
node --version
pnpm --version
gh --version
```

预期 Node 大版本至少为 22。版本差异过大时先统一环境，不要在依赖错误上盲改业务代码。

## A2. 克隆源码

```powershell
Set-Location C:\Users\Windows\Desktop\demo
git clone https://github.com/lilongyong333/nucleus-ai-builder.git nucleus-copy
Set-Location .\nucleus-copy
git status --short --branch
```

如果要复现本文档对应的完整功能分支：

```powershell
git fetch origin
git switch --track origin/agent/metagpt-quality-gate
git log -1 --oneline
git merge-base --is-ancestor feccdf10ce462a94b070ae629241cb3110dd4aa4 HEAD
```

第一条会显示当前分支最新提交；教学文档恢复后，它可能晚于生产运行时提交。第二条退出码应为 0，表示当前分支完整包含运行时基线。要精确查看线上运行的代码提交，用：

```powershell
git show --stat feccdf10ce462a94b070ae629241cb3110dd4aa4
```

如果 PR 已经合并到 main，则直接使用最新 main，并以 `git log -1 --oneline` 确认版本。

## A3. 安装锁定依赖

```powershell
pnpm install --frozen-lockfile
```

为什么带 `--frozen-lockfile`：它禁止安装器悄悄改锁文件，保证本机、CI 与部署尽量使用同一依赖树。

若原生依赖安装脚本被 pnpm 阻止，先看 `pnpm-workspace.yaml` 的精确白名单，不要全局允许所有依赖脚本。

## A4. 配置本地环境

```powershell
Copy-Item .env.example .env.local
```

编辑 `.env.local`：

```dotenv
OPENCODE_GO_API_KEY=在这里填新密钥
OPENCODE_GO_BASE_URL=https://opencode.ai/zen/go/v1
OPENCODE_GO_MODEL=gpt-5.6-luna
OPENCODE_GO_FALLBACK_MODEL=glm-5.2
OPENCODE_GO_CODE_MODEL=glm-5.2
OPENCODE_GO_CODE_FALLBACK_MODEL=gpt-5.6-luna
OPENCODE_GO_REQUEST_TIMEOUT_MS=26000
OPENCODE_GO_FALLBACK_RESERVE_MS=18000
OPENCODE_GO_CODE_REQUEST_TIMEOUT_MS=175000
OPENCODE_GO_CODE_FIRST_TOKEN_TIMEOUT_MS=140000
OPENCODE_GO_CODE_FALLBACK_RESERVE_MS=70000
OPENCODE_GO_MAX_MODEL_CALLS=60
OPENCODE_GO_MAX_TOTAL_TOKENS=500000
OPENCODE_GO_MAX_DURATION_MS=240000
OPENCODE_GO_STEP_MAX_CALLS=4
OPENCODE_GO_STEP_MAX_TOTAL_TOKENS=100000
OPENCODE_GO_STEP_MAX_DURATION_MS=280000
OPENCODE_GO_INTAKE_MAX_TOKENS=6000
OPENCODE_GO_IRIS_MAX_TOKENS=10000
OPENCODE_GO_BOB_MAX_TOKENS=12000
OPENCODE_GO_HTML_MAX_TOKENS=8000
OPENCODE_GO_CSS_MAX_TOKENS=12000
OPENCODE_GO_JS_MAX_TOKENS=14000
OPENCODE_GO_RAY_MAX_TOKENS=8000
OPENCODE_GO_REPAIR_MAX_TOKENS=16000
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

安全检查：

```powershell
git status --short
git check-ignore -v .env.local
```

第二条必须证明 `.env.local` 已被忽略。不要运行会把整个环境文件打印到录屏或 CI 日志的命令。

任何曾经公开粘贴过的 Key 都应在提供商后台撤销并重建。`.gitignore` 不能让已泄露的值重新安全。

## A5. 启动本地开发

```powershell
pnpm dev
```

浏览器打开：

```text
http://localhost:3000
```

第一次访问项目 API 时，`ensureSchema()` 会在本地 D1 binding 中幂等创建/升级表。先验证游客路径：

1. 首页输入一个短而具体的需求；
2. 创建项目并进入 `/w/<uuid>`；
3. 等待生成；
4. 确认版本 v1、Ray 分数、执行审计和启动校验；
5. 在 iframe 里实际点击一个功能；
6. 再输入一次修改需求；
7. 查看对话与版本。

本地环境默认没有 Sites 注入的 ChatGPT 身份头，因此显示游客工作区是正常的。不要让浏览器自行伪造身份头作为正式认证方案；账号路径由生产托管平台提供受信身份。

## A6. 跑完整质量门

另开 PowerShell：

```powershell
pnpm test
pnpm lint
pnpm exec tsc --noEmit
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

当前基线预期：

```text
Vitest:     30 passed
Playwright: 4 passed
TypeScript: passed
ESLint:     passed
Build:      passed
```

五项回答的问题不同：

| 检查 | 证明什么 |
|---|---|
| Vitest | 解析、身份、预算、质量、路由等纯逻辑正确 |
| ESLint | 常见代码规范、Hook 和可访问性问题受控 |
| TypeScript | 前后端共享数据结构没有明显断裂 |
| Build | 代码能进入真实 Worker 生产产物 |
| Playwright | 首页、工作台、账号中心和断流恢复主路径连得起来 |

## A7. 查看本地数据而不是猜

项目真源是 D1，不是 React state。可以从 API 验证：

```powershell
curl.exe -i http://localhost:3000/api/projects
```

浏览器的 visitor Cookie 决定游客所有权，因此裸 `curl` 与浏览器可能是两个不同 visitor。调试权限问题时必须先弄清调用者使用哪一份 Cookie。

---

## B. 从空项目逐层重建

最快、最可靠的学习方式不是重新手敲 10,000 行，而是用 Git 历史当“可执行教材”。

## B1. 建一个专用学习副本

```powershell
git clone https://github.com/lilongyong333/nucleus-ai-builder.git nucleus-rebuild
Set-Location .\nucleus-rebuild
git fetch --all
git switch --detach 3e47b89
pnpm install --frozen-lockfile
```

此时处于最早工程基线。运行：

```powershell
git log -1 --oneline
pnpm build
```

然后按顺序检查每个里程碑：

```text
3e47b89  工程基线
695b92e  核心生成产品
77e43a0  空回复重试
db59650  漏文件修复
cfc8f0a  公网限流
d792785  Ray 质量门
0188945  所有权/租约/取消/固定发布
acfcf17  GenerationRun/AgentEvent 审计
9fd6aae  登录/迁移/跨设备记忆
82fafec  主备模型/预算/超时
77d66fc  iframe 启动校验
fbfff24  长流恢复
761ec9d  确定性 Iris SOP
c26b0a2  生产模型顺序
feccdf1  最终真实基准和成品库
```

每到一个提交：

```powershell
git show <commit> --stat
git diff <commit>^ <commit>
git switch --detach <commit>
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

这样你看到的是“某个问题怎样导致一组最小修改”，比只读最终大文件更容易理解。

## B2. 如果真的从空文件夹手写

下面是推荐垂直切片。每个阶段都必须能运行，再进入下一阶段。

### 里程碑 1：工程壳

创建项目和依赖：

```powershell
New-Item -ItemType Directory nucleus-from-zero
Set-Location .\nucleus-from-zero
pnpm init
pnpm add next@16.2.6 react@19.2.6 react-dom@19.2.6 drizzle-orm@0.45.2 jszip@3.10.1 lucide-react@0.536.0 acorn@8.15.0
pnpm add -D typescript@5.9.3 vitest@4.1.10 @playwright/test@1.62.1 eslint@9.39.4 vinext@1.0.0-beta.2 vite@8.0.13 wrangler@4.92.0 @cloudflare/vite-plugin@1.37.1 @cloudflare/workers-types@5.20260808.1 drizzle-kit@0.31.10
```

先创建：

```text
app/layout.tsx
app/page.tsx
app/globals.css
worker/index.ts
vite.config.ts
tsconfig.json
eslint.config.mjs
vitest.config.ts
package.json scripts
```

完成标准：`pnpm dev` 有首页，`pnpm build` 产生 Worker 产物。

不要在这一阶段接模型。

### 里程碑 2：三文件类型、默认文件与 iframe

先定义 `GeneratedFiles`：

```ts
type GeneratedFiles = {
  "index.html": string;
  "styles.css": string;
  "script.js": string;
};
```

实现：

- `lib/types.ts`；
- `lib/runtime.ts`；
- `composePreview()`；
- sandbox iframe；
- 一个完全写死但真实可点击的 starter app。

完成标准：没有模型、没有数据库时，starter app 仍能新增/完成任务。先证明运行时，不要把所有故障混到一次调试。

### 里程碑 3：模型协议和解析器

实现：

- `.env.example`；
- `lib/opencode.ts`；
- `lib/parser.ts`；
- path code fence；
- 文件白名单、非空和大小限制；
- parser 单元测试。

完成标准：把一份手写模型回复交给 parser，稳定得到三文件；多余文件被忽略；增量文件能覆盖当前快照。

### 里程碑 4：D1 项目、消息和版本

实现：

- `db/schema.ts`；
- 第一份 `drizzle/*.sql`；
- `lib/db.ts`；
- `POST/GET /api/projects`；
- `GET /api/projects/:id`；
- `POST /api/runs` 与 `POST /api/runs/:id/step`；
- 旧 `/api/generate` 只作为兼容接口保留；
- `versions` 全量快照；
- `messages` 对话。

完成标准：刷新页面后项目仍在；生成 v2 后可恢复 v1，再恢复 v2。

### 里程碑 5：NDJSON 工作台

实现：

- `components/workbench.tsx`；
- `ReadableStream` 响应；
- 前端 `reader.read()` + buffer；
- status/plan/file/review/complete/error 事件；
- 预览/代码/手机切换。

完成标准：网络故意分块时 JSON 仍能解析；版本号只信服务端返回，不由前端猜。

### 里程碑 6：质量门

实现 `lib/quality.ts`：

- Acorn 语法解析；
- 危险节点；
- 真实交互；
- 语义、响应式和可访问性；
- 确定性评分；
- 通用检查、应用类型专项检查和 Ray 模型审查；
- 最多两轮定向修复，每轮重跑全部质量门。

完成标准：坏 JS 不能保存版本；假按钮应用不能得到通过；报告随 Version 持久化。

### 里程碑 7：所有权与并发

实现：

- `lib/session.ts`：随机 HttpOnly visitor；
- `owner_id`；
- 私有查询全部带 owner；
- `generation_id` 租约；
- 409 并发拒绝；
- cancel route；
- 旧写者终止；
- `published_version_id` 固定发布。

完成标准：两个独立 Cookie 会话中，非所有者读相同 UUID 返回 404；同项目第二个生成返回 409；取消后旧请求不能写版本。

### 里程碑 8：真实审计

实现：

- `generation_runs`；
- `agent_events`；
- 有序 sequence；
- Token、耗时、调用、repair、模型、错误；
- 工作台 audit card。

完成标准：成功、失败、取消都留下明确终态；公开页和项目列表不泄露私有审计内容。

### 里程碑 9：登录、迁移和记忆

实现：

- `app/chatgpt-auth.ts`；
- `lib/identity.ts`；
- `/api/session`；
- `/account`；
- visitor -> account 一次迁移；
- 最近 100 条 messages；
- 工作台/公开页完整 URL。

完成标准：两个 visitor 用同一受信账号身份时读到同一项目；迁移后旧 visitor 失去所有权。

### 里程碑 10：模型网关和预算

实现：

- `lib/model-gateway.ts`；
- 主备模型；
- 单次超时；
- 调用/Token/总时长共享预算；
- 401/429/取消不 fallback；
- 503/网络/超时/空回复受控处理。

完成标准：每个故障路径都有单测，不靠手工拔网线验证。

### 里程碑 11：启动校验和断流恢复

实现：

- runtime `ready/error/unhandledrejection`；
- NDJSON 心跳；
- 浏览器 fetch 断开后 GET 项目；
- `generating` 时轮询；
- 不重复 POST；
- 恢复/取消 UI。

完成标准：E2E 模拟打开时服务端正在生成，稍后返回 ready，UI 自动恢复且 POST 次数为 0。

### 里程碑 12：确定性规划与生产基准

把可确定的计划提取放进 `lib/planner.ts`，正常生成只保留一次代码模型请求。再用至少四种场景测试：CRUD、清单、看板、计时/输入型应用。

记录：

- 完成耗时；
- Tokens；
- 模型调用；
- Agent 事件；
- Ray 分数；
- 启动校验；
- 至少一个真实交互；
- 固定公开链接；
- 失败时的终态和恢复行为。

不要只保留最好截图。

---

## C. GitHub 交付

## C1. 建分支

```powershell
git switch -c feat/my-nucleus
git status --short
```

## C2. 提交前检查

```powershell
pnpm test
pnpm test:e2e
pnpm lint
pnpm exec tsc --noEmit
pnpm build
git diff --check
git status --short
```

密钥扫描示例：

```powershell
git grep -n -E "(BEGIN.*PRIVATE KEY|sk-[A-Za-z0-9]{20,})" -- .
```

如果命中真实 Key，先轮换，再处理 Git 历史。不要只删工作区文件。

## C3. 小步提交和 PR

```powershell
git add <本次相关文件>
git commit -m "feat: describe one reviewable change"
git push -u origin feat/my-nucleus
gh pr create --draft --base main --head feat/my-nucleus
gh pr checks --watch
```

PR 必须写：Summary、生产证据、Verification、Risk、Rollback、Secrets/Data 变化和诚实限制。

---

## D. Sites 生产部署

Sites 部署不是把本地开发服务器暴露到公网，也不是 GitHub Pages。

## D1. 构建和资源声明

确认 `.openai/hosting.json`：

```json
{
  "project_id": "你的 Sites project ID",
  "d1": "DB",
  "r2": null
}
```

project ID 可以入库；API Key、短期部署 Token 不可以。

运行：

```powershell
pnpm build
git rev-parse HEAD
git status --porcelain
```

部署只能绑定已经验证、已经 push 的精确 HEAD。工作区必须干净。

## D2. 配置生产环境变量

在 Sites 环境设置：

| 变量 | 类型 |
|---|---|
| `OPENCODE_GO_API_KEY` | secret |
| `OPENCODE_GO_BASE_URL` | regular |
| `OPENCODE_GO_MODEL` | regular |
| `OPENCODE_GO_FALLBACK_MODEL` | regular |
| `OPENCODE_GO_REQUEST_TIMEOUT_MS` | regular |
| `OPENCODE_GO_MAX_MODEL_CALLS` | regular |
| `OPENCODE_GO_MAX_TOTAL_TOKENS` | regular |
| `OPENCODE_GO_MAX_DURATION_MS` | regular |

不要把生产 Key 写入 `.openai/hosting.json`。

## D3. 让 Codex 执行 Sites 发布时应明确说什么

可以给 Codex 这样的任务：

```text
请使用 Sites 发布当前 Nucleus：
1. 读取并复用 .openai/hosting.json 的 project_id，不要新建第二个站点；
2. 先运行全部质量门并确认工作区干净；
3. 把精确 HEAD 推送到 Sites source repository；
4. 从同一 commit 构建和打包；
5. 保存不可变 site version；
6. 使用当前生产环境变量 revision 发布；
7. 轮询到 succeeded；
8. 用浏览器验收首页、API、登录、生成、账号中心和公开页；
9. 不要输出或持久化短期仓库 token。
```

Sites 内部 source credential 是短期凭据，只能作为单次 Git header 使用。不要把它写入 `origin`、`.gitconfig`、脚本或文档。

## D4. 版本与部署

正确链路：

```text
GitHub commit SHA
  == Sites source branch HEAD
  == build/archive source
  == saved site version commit_sha
  -> production deployment
```

如果四者不一致，就会出现“GitHub 看的是新版，线上跑的是旧版”。

## D5. 生产 smoke test

至少验证：

```text
GET  /                             200
GET  /api/session                  200
GET  /api/projects                 200
POST /api/projects                 201
POST /api/runs                     201 + runId
POST /api/runs/:id/step            NDJSON + step_complete/complete（循环）
GET  /api/projects/:id             200 for owner
POST /api/projects/:id/publish     publishedVersionId + slug
GET  /p/:slug                      200
```

浏览器还要验证：

- 首页布局与四个成品入口；
- 生成时 Agent 事件；
- Ray 分数与 audit；
- 启动校验通过；
- iframe 中真实交互；
- 登录后账号中心；
- 对话记忆；
- 工作台/公开成品详细链接；
- 固定发布版本；
- 取消与断流恢复。

## D6. 回滚

代码问题：把 production 指回上一成功 Sites version，或 `git revert` 后重新发布。

配置问题：恢复上一组模型/预算变量，再部署一个使用新环境 revision 的已保存版本。

数据库问题：优先前向修复和兼容 migration；不要为了回滚代码直接删除生产列。

---

## E. 当前生产证据

- 网站：<https://www.llynb.cc>
- Sites 备用地址：<https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site>
- GitHub：<https://github.com/lilongyong333/nucleus-ai-builder>
- PR：<https://github.com/lilongyong333/nucleus-ai-builder/pull/2>
- 复杂看板：<https://www.llynb.cc/p/app-0bd184>
- BudgetLens：<https://www.llynb.cc/p/budgetlens-4e9b1d>
- 面试清单：<https://www.llynb.cc/p/app-6e0e9a>
- 习惯打卡：<https://www.llynb.cc/p/app-c4fbb7>

复杂看板：21 秒、6,293 Tokens、1 次模型调用、11 事件、Ray 100/A，真实新增/搜索/两次流转/统计更新通过。

---

## F. 完成定义

你自己的复刻只有同时满足下面各项才算落地：

- [ ] 新电脑按 README 能安装；
- [ ] `.env.local` 不进入 Git；
- [ ] 本地游客路径能生成；
- [ ] 30 个单测和 4 个 E2E 全通过；
- [ ] CI 在干净 Linux 环境通过；
- [ ] 数据刷新后仍存在；
- [ ] 两个 visitor 数据隔离；
- [ ] 同项目并发被拒绝；
- [ ] 取消和断流有终态；
- [ ] 登录后项目和对话跨设备保存；
- [ ] 公开链接固定到明确版本；
- [ ] 生成物至少一个核心交互被实际点击；
- [ ] Sites 版本与 Git commit 一致；
- [ ] 失败样本、限制和下一步没有被隐藏。

做到这里，你交付的才是一个可演示、可解释、可继续开发的工程版本，而不是只能在作者电脑上运行的代码包。
