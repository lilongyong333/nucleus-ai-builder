# Nucleus 开发进度与验收记录

最后更新：2026-08-09

## 完成度

| 阶段 | 状态 | 结果 |
|---|---|---|
| 工程基线 | ✅ | 独立 Git 仓库、依赖锁定、密钥隔离 |
| 产品界面 | ✅ | 落地页、响应式三栏工作台、代码/预览切换 |
| AI 生成 | ✅ | OpenCode Go 规划 + 构建两阶段调用 |
| 运行时 | ✅ | 三文件组装、sandbox、错误桥、storage shim |
| 数据持久化 | ✅ | D1 schema、migration、运行期初始化 |
| 版本系统 | ✅ | 自动快照、列表、恢复任意版本 |
| 发布与导出 | ✅ | `/p/[slug]`、公开链接、ZIP 下载 |
| 质量验证 | ✅ | 测试、类型、lint、生产构建、真实 E2E |
| 在线部署 | ✅ | 公网站点、D1、服务端密钥和真实生成均已验证 |
| 公开源码 | ✅ | GitHub Public 仓库已推送，PDF 和密钥未入库 |

## API 与模型验证

- OpenCode Go `/models` 返回 25 个模型；
- `kimi-k2.7-code` 与 `glm-5.2` 冒烟调用成功；
- `deepseek-v4-flash` 在当前套餐返回 403，因此没有作为默认模型；
- `kimi-k2.7-code` 完整页面输出超过 180 秒；
- `glm-5.2` 完整生成实测约 32 秒，因此选为默认模型。

不是“调用所有模型后选最好”：这样会浪费套餐额度和时间。这里先查询完整列表，再对代表性代码模型做可用性与延迟验证。

## 真实端到端验收

测试需求：旅行预算规划器。

### 第一轮

- 创建项目成功，状态 `draft`；
- Planner 输出功能和视觉计划；
- Builder 32 秒内输出 `index.html`、`styles.css`、`script.js`；
- 文件体积约为 4.5KB / 8.7KB / 6.3KB；
- JavaScript `node --check` 通过；
- HTML 包含表单和按钮，JS 包含事件监听；
- v1 快照保存成功。

### 第二轮

修改需求：增加浅色 / 深色主题并记住选择。

- 首次模型只返回变化文件，旧解析器把缺少 `styles.css` 当成失败；
- 修复为“新文件覆盖、未返回文件沿用当前版本”的增量合并；
- 重试成功，生成 v2；
- 生成物包含主题切换逻辑；
- 恢复 v1 成功，再恢复 v2 成功。

### 发布

- 发布接口生成 slug；
- 公开页 HTTP 200；
- 页面包含全屏预览 iframe。

## 自动化结果

```text
Vitest          18 / 18 passed
Playwright      2 / 2 passed
TypeScript      passed
ESLint          passed
Production      passed
```

## 开发中发现并解决的问题

1. `pnpm` 默认阻止 `esbuild` / `workerd` 构建脚本：在 workspace 配置中精确允许。
2. Vinext 测试误加载 Cloudflare Vite 插件：增加独立 `vitest.config.ts`。
3. 大 JSON 代码输出转义失败：改为 path code fence 协议。
4. 增量修改偶尔只返回一个文件：与当前快照合并。
5. sandbox opaque origin 无法直接访问 `localStorage`：注入内存兼容层。
6. 旧 `.next` 类型污染 Vinext 类型检查：隔离旧构建产物，并让 ESLint 忽略 artifacts。
7. 线上 Builder 偶发返回空内容：增加一次自动重试，并在 reasoning 中包含完整 artifact 时容错提取。
8. 首轮生成偶发漏文件：检测缺失路径并发起一次定向补全，最终线上生成 13 个事件并成功保存 v1。
9. 公网站点会消耗订阅额度：生成接口使用 SHA-256 匿名指纹做每小时 8 次限流，不保存明文 IP。

## 正式线上验收

- 站点：https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site
- 源码：https://github.com/lilongyong333/nucleus-ai-builder
- 首页 HTTP 200，Nucleus 产品内容正常；
- `/api/projects` HTTP 200，D1 migration 正常；
- 线上创建“习惯打卡器”项目成功；
- 线上生成 HTTP 200，13 个 NDJSON 事件，最终状态 `ready`；
- `index.html`、`styles.css`、`script.js` 三文件齐全；
- 线上 v1 版本写入成功；
- 发布页 `/p/app-c4fbb7` HTTP 200，并包含全屏预览 iframe。

## 当前限制

- 生成物只支持浏览器前端三文件；
- 不能安装任意 npm 包；
- 生成应用的 storage 在每次预览页面生命周期内有效，不是 Nucleus D1 数据；
- 公开链接通过随机化 slug 分享，尚未实现细粒度权限；
- 默认模型响应通常需要 25–60 秒，取决于输出规模和服务负载。

## 第四轮：账号、跨设备记忆与模型可靠性

- 接入 Sites 托管的 Sign in with ChatGPT，不自行处理密码；
- 受信平台身份头映射到稳定账号 owner，第一次登录自动迁移当前匿名 visitor 项目；
- 账号中心展示所有项目、版本/消息/运行统计、工作台详细链接和公开成品链接；
- 项目详情读取最近 100 条用户/助手消息，工作台新增“项目对话记忆”抽屉；
- 两个不同 visitor 会话使用同一账号身份时可读取同一项目；迁移后旧匿名身份不再拥有项目；
- 模型网关新增主备模型、55 秒单次超时、8 次调用、50,000 Tokens 和 240 秒整轮预算；
- 503、超时、空回复可受控降级；401/429 不被备用模型掩盖；取消不触发备用模型；
- D1 的 GenerationRun 和 Version 记录实际模型链，而不是只记录配置中的主模型；
- 生产模型探针中 `qwen3.5-plus` 在 26.1 秒返回结构化计划，但复杂三文件生成仍超过边缘长连接窗口；Iris 本地化后，代码主备顺序按真实生成延迟调整为 GLM → Qwen。

### 第四轮验证

- Vitest 28/28：新增身份迁移、主备成功/失败、空回复、超时、401、取消、调用和 Token 预算测试；
- Playwright 3/3：新增登录账号项目中心与对话记忆；随后断流恢复测试使总数达到 4/4；
- 本地真实 D1 身份链：匿名创建 201、账号迁移后读取 200、旧 visitor 404、第二设备同账号 200；
- 生成后对话保留 2 条用户消息，取消运行终态为 `cancelled`；
- Sites version 12 从 `77d66fc765ba00c7f2fa653476b02b377d70322b` 发布，账号登录与项目中心生产验收通过。

## 第五轮：真实上限基准推动的断流恢复

多场景生产基准没有只记录成功。复杂看板和打字挑战在长模型阶段暴露浏览器流 `network error`、服务端租约仍运行的问题。完成以下修复：

- NDJSON 每 8 秒写入透明心跳，并设置 `Cache-Control: no-cache, no-transform` 与 `X-Accel-Buffering: no`；
- 浏览器流失败后立即读取项目状态；服务端仍运行时显示“连接恢复中”，并轮询同步完成/失败终态；
- 页面重新打开时，只有 `draft + v0` 才自动开始第一轮；`generating` 项目只恢复状态，不重复 POST；
- 远端任务在本地流结束后仍显示“取消生成”，可可靠释放租约；
- 顶栏不再把所有非本地生成状态都显示为“已保存”，现在区分草稿、生成中、生成失败和已保存。

### 第五轮验证

- Vitest 30/30、Playwright 4/4、TypeScript、ESLint、生产构建全部通过；
- 新 E2E 模拟首次 GET 返回 `generating`、轮询后返回 `ready`，断言工作台自动显示 v1 且 `/api/generate` POST 次数为 0；
- GitHub Actions `verify` 通过；
- Sites version 13 从 `fbfff24a736546611eb34bc0034a4fa3da14e329` 发布；
- 生产上重新打开两个遗留项目均正确显示“生成中”和取消入口，取消后自动变为“草稿”，运行审计变为“已取消”。

### 第六轮：确定性 Iris SOP

- 保留 MetaGPT 式角色、阶段、结构化计划和审计工件，但让 Iris 在本地按确定性规则提取应用名、功能与视觉方向；
- 规划阶段变为毫秒级、零 Token、零模型调用；正常新建应用从两次模型往返降为一次；
- 新增 2 个规划器单测，使 Vitest 总数达到 30；
- 首页新增三个可直接打开的生产成品入口，明确区分“用提示词新建”和“查看固定发布版本”。

## 真实 Demo 基准

详细方法和第一梯队对照见 `docs/UPPER-BOUND-BENCHMARK.md`。已完成的 BudgetLens 财务 CRUD：38 秒、7,470 Tokens、2 次模型调用、11 个事件、Ray 100/A；人工新增 123 元记录后明细和统计更新，并发布为 `/p/budgetlens-4e9b1d`。

## 第三轮：可审计的多智能体运行

- 新增 `generation_runs` 和 `agent_events` 两类 D1 工件，不再只把 Agent 协作显示成前端动画；
- 同一 generation ID 同时作为运行 ID，保存提示词、模型、开始/结束时间、总耗时、Token、模型调用数、Ray 修复次数、关联版本和终止原因；
- Iris、Bob、Alex、Ray 的需求、架构、实现、文件工件、质量门和失败阶段按严格递增序号持久化；
- OpenAI-compatible `usage` 会被标准化并跨空响应重试、缺失文件补全和 Ray 修复调用累加；供应商不返回 usage 时明确显示 `—`，不伪造数字；
- 工作台新增可展开“执行审计”卡片，显示最近一轮状态、耗时、Token、模型调用、事件数量、模型和修复次数；
- 项目详情返回最近 10 次运行；项目列表和公开发布页不返回私有审计轨迹；
- 取消、配额拒绝、模型失败、过期回收和成功保存都有终态。事件插入和版本保存必须再次验证运行仍为 `running`，阻止取消后的迟到响应落库；
- migration `0005_fuzzy_phantom_reporter.sql` 已生成并检查，运行时初始化兼容已有 D1，索引后执行 `PRAGMA optimize`。

### 第三轮验证证据

- TypeScript、ESLint、生产构建均通过；
- Vitest 18/18：新增 usage 规范化/累加测试，以及模型失败时终态事件和 metrics 持久化测试；
- Playwright 2/2：工作台能显示运行摘要，并可展开查看 Agent 事件；
- 真实本地 D1 取消链路：创建 201、生成流 200、取消 200、读取 200；项目回到 `draft`，运行状态为 `cancelled`，耗时 184ms，版本数为 0，已保存 1 条取消前事件；
- GitHub Actions `verify` 在 Linux + Chromium 环境通过；
- Sites 版本 10 从提交 `8e6c54f23eb165e83fca43e00037584ec5af66cb` 发布成功，首页和工作台正常打开；
- 新匿名会话真实生成“面试准备清单”：18 秒完成、4,954 Tokens、2 次模型调用、0 次 Ray 修复、11 条有序事件，运行状态 `completed`，模型 `glm-5.2`；
- 该运行成功关联 v1，Ray 质量门 100/A、9/9 通过；工作台可展开显示 Iris/Bob/Alex/Ray 的阶段和用量；
- 生成应用实际完成“新增任务 → 键盘勾选完成 → 完成筛选”，进度从 0/1 更新为 1/1、100%，证明交付物不是静态 PoC。

## MetaGPT-inspired 质量闭环

在审阅 MetaGPT 官方仓库的 Role / Action / Message / Environment 和 QA 测试循环后，Nucleus 增加了真实的 Ray 质量门，而不是只显示检查状态：

- Acorn 解析模型生成的 JavaScript AST，不执行生成代码；
- 覆盖语法、安全、真实交互、语义 HTML、移动 viewport、响应式 CSS、表单可访问名称、键盘焦点和自包含交付 9 项规则；
- 阻断 `eval`、动态 Function、`document.write` 和跨窗口 DOM 等高风险调用；
- 首次不通过时，把结构化问题交给 Ray 定向修复并重新执行全部检查；
- 只有通过质量门的文件才能保存为版本；
- 每个版本在 D1 持久化 0–100 分、A–D 等级和逐项结果；
- 工作台和版本历史展示质量结果；
- 自动测试从 6 个增加到 11 个，并新增 GitHub Actions CI。

## 第二轮：生产可靠性与交付一致性

- 用 32 位随机 HttpOnly Cookie 建立匿名工作区，所有私有项目 API 都要求会话所有权；跨会话读取返回 404；
- 为旧数据保留一次性认领迁移路径，新建项目从创建时即绑定所有者；
- 同一项目使用带随机 generation ID 的原子租约，只允许一个活跃生成任务；10 分钟后可回收异常遗留租约；
- 工作台提供“取消生成”，原请求的 AbortSignal 会传到规划、构建、补文件和 Ray 修复；显式取消 API 同时撤销数据库租约；
- 失败或取消只释放自己的 generation ID，过期任务不能覆盖新任务状态；
- 发布时写入 `published_version_id`，公开页读取不可变版本快照；迁移会冻结已有公开链接当前版本；
- 版本号增加 `(project_id, version_number)` 唯一索引，作为并发写入的数据库级最后防线；
- 新增 3 个会话单元测试和 2 个 Playwright 浏览器 E2E；自动验证现为 Vitest 14/14 + Playwright 2/2；
- GitHub Actions 会在 Linux 上完成依赖安装、单测、Lint、类型检查、生产构建和 Chromium E2E。

### 第二轮生产验收

- Sites 版本 8 从提交 `5655d9efcc1960733558b6181c1d600e0fa89e3c` 发布成功；
- 两个独立 Cookie 会话：所有者读取项目返回 200，另一会话读取相同 UUID 返回 404，项目列表也不泄露；
- 同一项目首个生成请求返回 200，第二个并发请求返回 409；显式取消返回 200，项目恢复 `draft` 且没有产生版本；
- 发布冻结专用项目先生成并发布 v1，再生成包含唯一文本 `IMMUTABLE DRAFT 3` 的 v2；
- v2 私有文件包含该文本，但未重新发布的公开页前后均不包含；数据库中 `currentVersionId` 与 `publishedVersionId` 指向不同版本；
- v2 Ray 质量结果为 100/A 且通过；公开 v1 页面 HTTP 200：`https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site/p/app-6e0e9a`；
- Node/undici 自动化会被站点边缘 Bot 防护返回 403；浏览器型 PowerShell 和 .NET HttpClient 在获得边缘 Cookie 后均可正常验收。该 403 与应用 API 授权状态分开记录。
