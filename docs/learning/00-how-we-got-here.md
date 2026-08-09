# 00. 这套产品是怎样一步步做出来的

> 生产运行时代码基线：Nucleus commit `feccdf10ce462a94b070ae629241cb3110dd4aa4`，Sites production version 16，2026-08-09。教学文档提交可以位于该运行时提交之后。

这不是一份“AI 一次生成了整个项目”的包装稿。本章按真实 Git 历史说明做了什么、为什么做、遇到什么故障、最后留下了什么工程工件。你可以运行下面的命令核对：

```powershell
git log --reverse --oneline
git show <commit-id> --stat
git show <commit-id>
```

## 1. 最初拿到的不是技术方案，而是交付约束

原始笔试最重要的要求是：

- 必须有评审可直接打开的在线链接；
- 必须有真实可操作功能，不是截图、Figma 或假进度；
- 要能解释代码、工程过程和取舍；
- 要提交源码与文档。

因此第一步不是挑最酷的框架，而是写出一条可验收主链路：

```text
输入需求
  -> 创建项目
  -> 生成代码
  -> 真实预览
  -> 保存版本
  -> 继续修改
  -> 发布固定链接
  -> 下载源码
```

产品边界被主动限制为自包含的 `index.html + styles.css + script.js`。这样不需要在服务器执行模型生成的任意代码，也不需要安装不可信 npm 依赖，能把时间集中在可靠性、版本、身份、测试和部署。

## 2. 第一阶段：工程基线与最小产品闭环

### `3e47b89`：工程基线

建立 Next.js/Vinext、React、TypeScript、Vite/Cloudflare Worker、ESLint、Vitest 和基础目录。

对应工件：

- `app/`：页面与 API；
- `worker/index.ts`：Worker 入口；
- `vite.config.ts`：Vinext、Sites、Cloudflare 插件；
- `db/schema.ts`、`drizzle/`：D1 数据模型；
- `package.json`：可重复的 dev/test/build 命令。

### `695b92e`：第一版完整产品

完成首页、工作台、模型生成、三文件解析、iframe 预览、D1 项目/消息/版本、恢复、发布和 ZIP 下载。

第一版已经能跑通，但还存在典型 AI 工程问题：模型空回复、漏文件、大 JSON 损坏、任意访客读写、并发覆盖、公开页漂移等。

## 3. 第二阶段：处理模型输出的不确定性

### `77e43a0`：空回复重试

外部模型 HTTP 200 不代表业务成功。接口偶尔返回空 `message.content`，因此增加内容校验和一次受控重试。

### `db59650`：首次漏文件定向修复

模型可能只返回 HTML/JS 而缺 CSS。系统不再盲目重跑整个请求，而是：

1. 解析已生成文件；
2. 计算缺失文件集合；
3. 只要求模型补缺失文件；
4. 合并后重新校验。

这形成最早的“生成 -> 检测 -> 定向修复 -> 再校验”闭环。

### 协议层取舍

最初尝试过大 JSON 文件对象，但长代码里的引号、反斜杠和换行很容易造成 JSON 截断。最终改为带路径的 Markdown code fence：

````text
```html{path=index.html}
...
```
````

协议改变比反复加强 Prompt 更可靠。

## 4. 第三阶段：第一次生产部署和成本保护

### `879ce26`、`4ffadb3`

记录生产验证，补齐在线链接和公开源码入口。

### `cfc8f0`：公网站点限流

任何访客都能调用付费模型会产生成本攻击面。D1 新增按匿名指纹和小时计数的原子限额，默认每小时 8 次，超出返回 429 和 `Retry-After`。

限流只是成本保护，不等于身份认证。

## 5. 第四阶段：借鉴 MetaGPT，但不复制 MetaGPT

研究 MetaGPT 后，采用的是这些原则：

- 角色有明确职责；
- 每一阶段产出结构化工件；
- SOP 限制执行顺序；
- 测试/审查结果进入闭环；
- 成本和轮次必须有上限。

Nucleus 不是 MetaGPT 的 Python 分支，也没有复制它的 Role/Action/Environment 源码。它在 Worker 约束下独立实现 Iris（需求）、Bob（架构）、Alex（开发）、Ray（质量）四个可观察阶段。

### `d792785`：Ray 确定性质量门

新增 9 项检查：

- JavaScript 语法（Acorn AST）；
- 危险运行节点；
- 真实交互；
- 语义 HTML；
- viewport；
- 响应式 CSS；
- 表单可访问名称；
- 键盘焦点；
- 自包含交付。

语法、安全或真实交互不通过会阻止保存，并触发最多一次定向 Ray 修复。质量报告持久化到 Version，而不是只显示一个动画分数。

### `5a2f560`：修复 CI 与 Sites 构建差异

本地能 build 不代表 CI 能 build。部署插件原先依赖本机路径，Linux CI 找不到。修复为仓库内可追踪源码后，GitHub Actions 才能在干净环境复现。

## 6. 第五阶段：所有权、并发、取消和固定发布

### `0188945`

这一轮解决“功能能用，但多人/多标签页会破坏数据”的问题：

- 32 字节随机 HttpOnly visitor Cookie；
- 所有私有项目 API 按 `owner_id` 过滤；
- 越权统一返回 404，避免泄露资源是否存在；
- `generation_id` 建立同项目单写者租约；
- 第二个并发生成返回 409；
- AbortSignal 传播到模型 fetch；
- 取消接口撤销租约；
- 旧请求即使晚到也不能写入新版本；
- `published_version_id` 与 `current_version_id` 分离，公开链接固定到明确版本。

### `f962837`

加入 Playwright 用户主路径，避免只测试纯函数却漏掉页面连接问题。

## 7. 第六阶段：把 Agent 动画变成真实审计

### `acfcf17`

新增：

- `generation_runs`：一轮生成的总账；
- `agent_events`：每个阶段的有序明细；
- 耗时、Token、调用次数、修复次数、模型、错误和终态；
- completed/failed/cancelled/rejected/running 明确状态；
- 运行记录关联最终 Version。

### `133b7fc`

覆盖成功、失败、取消、终止后拒绝继续写事件等生命周期测试。

这一步让面试官看到的 Iris/Bob/Alex/Ray 不再是前端假进度，而是 D1 中可追溯的执行工件。

## 8. 第七阶段：账号登录、跨设备项目与对话记忆

### `9fd6aae`

接入 Sites 托管的 Sign in with ChatGPT：

- 未登录时仍可直接体验；
- Worker 读取平台注入的受信身份头；
- 账号 owner 使用稳定的 `chatgpt:<user-id>`；
- 第一次登录把当前 visitor 项目迁移到账号；
- 账号中心列出项目、状态、版本和成品；
- 每个项目显示完整工作台链接与公开链接；
- 项目详情返回最近 100 条消息、20 次运行、200 个事件；
- 工作台增加对话记忆抽屉。

Nucleus 不自行保存密码。游客 Cookie 与登录身份解决的是两条不同路径：打开即用，以及登录后跨设备保存。

### `4963916`

测试两个不同 visitor 使用同一账号身份能读取同一项目；迁移后旧 visitor 不再拥有项目；E2E 覆盖账号项目中心和详细链接。

## 9. 第八阶段：模型网关、预算和故障注入

### `82fafec`

把直接模型请求抽成 `lib/model-gateway.ts`：

- GLM/Qwen 主备链；
- 单请求超时；
- 整轮调用、Token、时间预算；
- 网络、5xx、超时、空回复的受控重试/降级；
- 401/429 不用备用模型掩盖；
- 用户取消立即传播，不触发 fallback；
- 最终模型链写入审计和 Version。

故障测试覆盖：主模型成功、503、超时、401、取消、空回复、调用预算、Token 预算。

## 10. 第九阶段：证明生成物真的启动

### `77d66fc`

iframe runtime 增加 `ready`、`error`、`unhandledrejection` 消息。工作台显示：

- 启动校验中；
- 启动校验通过；
- 发现运行错误。

“静态检查通过”与“浏览器能启动”从此是两份不同证据。

## 11. 第十阶段：长连接故障与恢复

### `fbfff24`

复杂看板/打字应用真实生成时出现浏览器 `network error`，但服务端租约仍在。修复包括：

- NDJSON 每 8 秒透明心跳；
- `no-cache, no-transform` 和禁代理缓冲头；
- 浏览器断流后读取服务端项目状态；
- 服务端仍生成时显示“连接恢复中”并轮询；
- 完成/失败后自动同步终态；
- 重新打开 `generating` 项目绝不重复 POST；
- 遗留任务始终保留取消入口；
- 顶栏区分草稿、生成中、失败、已保存。

E2E 专门模拟“首次读取正在生成，第二次轮询完成”，并断言生成 POST 次数为 0。

## 12. 第十一阶段：用生产数据优化规划和模型顺序

### `761ec9d`：Iris 确定性 SOP

真实基准发现，模型规划占据一段完整网络往返。规划内容其实是可确定的应用名、摘要、功能和视觉方向，因此改为 `lib/planner.ts` 本地提取：

- 0 Token；
- 0 模型调用；
- 0–1ms；
- 保留结构化计划和 Agent 审计；
- 正常新建从两次模型调用降到一次。

这是“借鉴 MetaGPT SOP”而不是“为了多 Agent 多调几次模型”：确定性任务应该交给代码。

### `c26b0a2`：GLM 调回代码主模型

Qwen 规划探针较好，但复杂三文件生成超过边缘长连接窗口。GLM 在相同复杂看板上更快，因此生产主备顺序改为：

```text
glm-5.2 -> qwen3.5-plus
```

失败样本没有删除。它保留为“选模型必须看真实工作负载，不能只看小探针”的证据。

## 13. 第十二阶段：真实成品与最终证据

### `fedb86d`

新增企业教学手册、第一梯队能力上限矩阵、MetaGPT/MGX/Lovable/Bolt/Replit/v0 官方文档对照和许可证说明。

### `feccdf1`

复杂面试看板最终生产结果：

- 21 秒；
- 6,293 Tokens；
- 1 次模型调用；
- 11 个 Agent 事件；
- GLM-5.2；
- Ray 100/A；
- 新增、搜索、待办 -> 进行中 -> 已完成均通过；
- 任务总数 4 -> 5；
- 完成率 25% -> 20% -> 40%；
- 固定公开链接发布成功；
- 账号中心显示工作台和成品详细链接。

同时首页加入四个可直接测试的固定成品，而不是只放“点击后重新消耗额度生成”的概念卡片。

## 14. 最终质量门

当前交付在本地和 GitHub CI 同时通过：

```powershell
pnpm test             # 当前基线 41/41
pnpm test:e2e         # 当前基线 7/7 Chromium
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

此外还完成：

- Git 高置信密钥扫描；
- GitHub Draft PR；
- Linux + Chromium CI；
- 每次 Sites version 都与已推送 commit 精确绑定；历史 version 16 对应 `feccdf1...`，后续流式输出与对话工作台版本见 `docs/PROGRESS.md`；
- 首页与四个公开 Demo HTTP 200；
- 生产登录、账号中心、复杂交互和固定发布人工验收。

## 15. 你应该从这段历史学什么

项目不是靠一次“写完”，而是靠证据驱动收敛：

```text
需求约束
  -> 最小闭环
  -> 真实上线
  -> 暴露故障
  -> 建立确定性防线
  -> 自动回归
  -> 再上线验证
  -> 把证据写入代码、测试和文档
```

如果从零学习，不需要一次实现全部。按照本章提交顺序逐段运行和比较，就是最接近真实企业项目的学习方式。

## 16. 第十三阶段：从“单次生成”升级为可恢复软件团队

用户用“贪吃蛇”验证时，旧架构同时暴露两个不能靠 UI 修饰的问题：

1. 新 draft 直接显示 starter Todo，失败也像已有成果；
2. 整轮生成依赖一个 60 秒请求，提高 `max_tokens` 反而更容易被平台终止。

正式修复先完成 P0：v0 显示真实空状态、必须显式开始、没有 Version 就不能发布/下载、只有同一 Run 的完整三文件 Artifact 才能显示候选预览。

再完成 P1：

```text
POST /api/runs
  -> requirements (Iris model)
  -> architecture (Bob model)
  -> index.html (Alex model)
  -> styles.css (Alex model)
  -> script.js (Alex model)
  -> quality (Ray model + deterministic checks)
  -> repair -> quality (最多两轮)
  -> finalize -> Version
```

每个箭头之间都写入 D1 的 `current_stage`、Artifact、ModelAttempt 和 AgentEvent；浏览器断开时只重跑没有完成的当前阶段。整轮额度提高到 24 次调用/180K Tokens，单阶段仍控制为 2 次/40K/52 秒。需求/架构/审查使用 `gpt-5.6-luna → glm-5.2`，代码使用 `glm-5.2 → gpt-5.6-luna`。

生产 v22–v25 又依次暴露了跨文件输出、Bob 矛盾交接、截断流误判和外部脚本引用误判。最终把文件职责锁进代码、在保存前检查三文件协议、要求 SSE 正常结束，并只移除平台会重复注入的本地文件引用。最终门禁为 41/41 Vitest、7/7 Playwright、TypeScript、ESLint、production build 和 `git diff --check`；真实贪吃蛇以 Ray 100/A 保存并发布，详细证据见 `docs/PROGRESS.md` 最后一节。
