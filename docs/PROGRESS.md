# Nucleus 开发进度与验收记录

最后更新：2026-08-12

## 完成度

| 阶段 | 状态 | 结果 |
|---|---|---|
| 工程基线 | ✅ | 独立 Git 仓库、依赖锁定、密钥隔离 |
| 产品界面 | ✅ | 落地页、响应式三栏工作台、代码/预览切换 |
| AI 生成 | ✅ | Iris → Bob → Alex 三文件 → Ray 审查/修复的真实分步模型工作流 |
| 运行时 | ✅ | 三文件组装、sandbox、错误桥、storage shim |
| 数据持久化 | ✅ | D1 Run、Stage、Artifact、ModelAttempt、Event、Version 与 migration |
| 版本系统 | ✅ | 自动快照、列表、恢复任意版本 |
| 发布与导出 | ✅ | `/p/[slug]`、公开链接、ZIP 下载 |
| 质量验证 | ✅ | 通用 9 项门、三文件协议门、贪吃蛇专项契约、模型审查、41 单测、7 浏览器 E2E |
| 在线部署 | ✅ | 公网站点、D1、服务端密钥和真实生成均已验证 |
| 公开源码 | ✅ | GitHub Public 仓库已推送，PDF 和密钥未入库 |

## API 与模型验证

2026-08-09/10 对当前 Go 套餐重新查询并做结构化规划与长代码探针后，正式分步链路选择 `gpt-5.6-luna` 为主模型、`glm-5.2` 为备用。`gpt-5.6-luna` 的结构化规划探针约 4.1 秒，代码探针约 15.4 秒；`glm-5.2` 对应约 11 秒和 24.7 秒。Qwen/Kimi 的部分长代码探针超过 48 秒，因此没有放在正式主备位。以下早期 GLM/Kimi 记录保留为历史证据，不再代表当前默认配置。

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
Vitest          70 / 70 passed
Fixed Eval      25 / 25 passed
Playwright      7 / 7 passed
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

详细方法和第一梯队对照见 `docs/UPPER-BOUND-BENCHMARK.md`。面试项目冲刺看板在确定性 Iris + GLM 代码主模型下 21 秒完成，6,293 Tokens、1 次模型调用、11 个事件、Ray 100/A；人工验证新增、搜索、两次流转和完成率更新，并发布为 `/p/app-0bd184`。BudgetLens 财务 CRUD 为 38 秒、7,470 Tokens、2 次模型调用、11 个事件、Ray 100/A；人工新增 123 元记录后明细和统计更新，并发布为 `/p/budgetlens-4e9b1d`。

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

## 第七轮：自定义域名与长期托管

- 2026-08-09 将 `www.llynb.cc` 添加到现有 Nucleus Sites 项目，避免为 Railway 复制 Worker、D1、身份和环境变量；
- 上线前确认 `www` 原 Cloudflare Tunnel 目标返回 530，而 `agent.llynb.cc` Railway 服务仍返回 200；
- 只替换 `www`：CNAME 指向 `custom-domains.chatgpt.site` 并设为 DNS only，增加 Sites 签发的两条 TXT；
- `agent`、`api`、`game` 和 `atoms` 记录均未修改；
- Sites custom domain、provider 和 SSL 三个状态均达到 `active`；
- 公共 1.1.1.1 DNS 返回正确 CNAME；`https://www.llynb.cc` 和 `/api/session` 均返回 200；
- 浏览器从自定义域名打开复杂看板并新增“验证 www.llynb.cc 长期在线”，总数 4→5、完成率 25%→20%；
- 完整配置、以后发布和回滚步骤见 `docs/CUSTOM-DOMAIN-DEPLOYMENT.md`。

## 第八轮：登录后导航失效修复

- 在已登录的 `https://www.llynb.cc/account` 复现：姓名、邮箱和三个项目正常，证明身份注入和 D1 读取成功；
- “新建应用”和“打开工作台”均有正确 `href`，但真实点击后 URL 不变；
- 浏览器 Console 捕获 Vinext RSC prefetch/navigation `TypeError`，根因定位为客户端路由运行时，而不是 OAuth 回调或项目权限；
- 账号页、首页、最近项目和工作台的关键跨页面入口统一改为完整文档导航，保留同域登录并绕开故障代码；
- Playwright 从仅检查链接属性升级为真实点击完整闭环：账号页 → 工作台 → 首页 → 项目中心 → 新建应用；
- Vitest 30/30、ESLint、TypeScript、生产构建和 Chromium Playwright 4/4 通过。

## 第九轮：真实模型流与 60 秒生成窗口

- 根据用户截图定位“左栏空白、顶部一直生成中”，生产 Worker 日志显示对应 `/api/generate` 在 `60,285ms` 被托管平台以 `outcome=canceled` 强制终止；
- 原实现虽然向浏览器返回 NDJSON 阶段事件，但 OpenCode 请求使用 `stream:false`，因此 Alex 代码生成阶段只能等待完整答案，不能展示模型片段；
- 模型网关改用 OpenAI-compatible SSE，逐片读取 `delta.content`；推理字段只在服务端兼容解析，不向界面展示；
- 首次线上验收进一步发现 `ReadableStream.start` 被声明为 `async` 时，浏览器会等待整个启动 Promise 结束才消费队列；改为同步 `start` 后在内部启动独立异步任务，使首个 Iris 事件无需等待模型完成即可到达；
- `/api/generate` 将高频 Token 合并为约 160ms/180 字符一批的进度事件，降低浏览器重绘压力；工作台新增真实输出浮层，显示当前 Agent、阶段、用时、实时尾部文本和已接收字符数；
- 页面刷新或连接恢复时，从 D1 最近运行的 `agent_events` 重建时间线，不再出现只有“Iris 正在工作”但左栏完全空白；
- 线上生成预算从 240 秒收紧到 48 秒，单次模型等待上限 40 秒，并在托管平台终止前写入明确失败终态；超过 65 秒的遗留租约会在项目读取时自动回收；
- 失败项目保留已有版本，并提供“重试上次生成”按钮；全新项目失败后也不再锁住 10 分钟；
- 用中文打字速度应用做真实 Go 套餐基准：GLM-5.2 在紧凑三文件协议下约 6.9 秒首片、24.6 秒完成，返回 11,001 字符且三文件齐全；据此保留 GLM 主模型，不凭短回复速度盲目换模型；
- 模型网关新增 SSE 分片、usage 汇总、隐藏推理不外泄和请求参数回归测试，并新增“模型尚未完成时必须读到首个 Agent 事件”的路由测试；Vitest 32/32、Chromium Playwright 4/4、ESLint、TypeScript 和生产构建全部通过。

## 第十轮：对话式工作台与可连续操作的消息队列

- 参考 Atoms 的交互信息结构重新设计工作台左栏，但保持 Nucleus 自己的品牌、数据模型和实现，不复制对方代码或素材；
- D1 中的 `messages` 直接成为主工作区消息流，用户需求、Alex 交付摘要、时间和复制操作不再只藏在抽屉里；
- 最近一轮 GenerationRun 与 AgentEvent 会插入到对应用户消息之后，形成“用户需求 → 已处理步骤 → 智能体答复”的可解释链路；
- 生成中继续按 Return 会把消息加入本地串行队列；当前任务完成后自动取下一条，避免并发覆盖同一项目；停止当前任务会暂停队列，由用户明确点击“继续队列”；
- 编辑器支持 Return 发送、Shift+Return 换行、四种快捷指令和 Web Speech API 中文语音输入；不支持语音的浏览器会给出明确降级提示；
- 修正新一轮生成计时错误：本地 POST 发起时使用独立开始时间，不再误用上一轮 D1 `startedAt` 而显示几十或几百秒；刷新恢复时仍以服务端运行时间为准；
- iframe 运行时桥接 `console.log/info/warn/error`，工作台控制台同时接收真实日志、启动成功和运行错误，最多保留最近 100 条；
- 生成中的模型分片除右侧浮层外，也会进入当前智能体消息，显示真实尾部内容和累计字符数；
- Playwright 新增“第一条请求未完成时，第二条按 Return 入队并自动接续”的回归；生产域名验收还发现跨匿名会话打开无权限项目时会永远停在 loading，现改为明确的 404/权限错误页并增加第 6 条 E2E；当前 Vitest 32/32、Chromium Playwright 6/6、ESLint 和 TypeScript 全部通过。

## 第十一轮：正式可恢复多 Agent 工作流（P0/P1）

这轮直接针对“贪吃蛇为什么失败却仍显示旧 Todo Demo”和“只提高 Token 为什么仍卡在 60 秒”两个根因，不再继续给旧单请求链路打补丁。

### P0：交付真实性

- 创建 draft 后不再自动启动模型；用户明确点击开始才花额度；
- 没有 Version 时，右侧显示 `VERSION 0 · NO GENERATED APP`，不再把 `starterFiles` 当成本次模型成果；
- 只有同一 Run 已保存完整 HTML/CSS/JS Artifact 时，才允许显示“待 Ray 审查候选”；
- v0 的发布和下载入口禁用；生成失败不会拿无关旧 Demo 掩盖；
- 修复运行恢复状态的 UI 证据和失败/取消文案，避免把 error 显示成“团队已完成”。

### P1：真实、可恢复、可审计

- 新增短请求 `POST /api/runs` 创建 Run，`POST /api/runs/:id/step` 一次只执行一个阶段；
- Iris、Bob、Alex HTML、Alex CSS、Alex JS、Ray quality、Ray repair、finalize 都有持久化 `current_stage`；
- 新增 `generation_artifacts`，对 requirements、architecture、三个代码文件和 quality 做 `(run_id, kind)` 唯一检查点；
- 新增 `model_attempts`，保存模型、状态、阶段、耗时、首字时间、输出字符数、HTTP 状态、usage 和错误；浏览器中断记为 `cancelled`；
- 项目 generation lease 与阶段 active-step lease 双重阻止并发；阶段断开后只重跑当前未完成工件；
- 整个 Run 24 次调用/180K Tokens 硬上限，单阶段 2 次/40K/52 秒；需求类主模型 26 秒并为备用预留 18 秒，代码类主窗口 34 秒并预留 16 秒；达到预算直接终止并保留检查点；
- 需求/架构/审查使用 `gpt-5.6-luna → glm-5.2`；生产 v22 发现 Luna 在 Alex HTML 阶段会越界生成其他文件，故代码路由改为 `glm-5.2 → gpt-5.6-luna`；HTML/CSS/JS 分别 4K/6K/14K Tokens，修复最高 16K；
- Bob 的三文件职责改为平台不可变契约；HTML/CSS/JS 与 Ray 修复工件保存前分别验证跨文件污染、Markdown 残留、完整文档、CSS 括号和 Acorn JavaScript 语法；
- SSE 只有收到 `[DONE]` 或正常 `finish_reason=stop` 才算完整；连接提前结束或 `finish_reason=length` 记录为 `incomplete`，可在工作台审计并触发备用模型；
- Ray 同时执行通用确定性质量门、真实模型逐项审查和最多两轮定向修复；贪吃蛇额外要求运行循环、方向控制、场景渲染、食物计分和生命周期证据；
- migration `0006_familiar_iron_monger.sql` 增加阶段租约、Artifact 和 ModelAttempt 表/索引，运行期 schema 初始化兼容已有 D1。

### 本地发布门

- TypeScript：通过；
- ESLint：通过；
- Vitest：41/41；
- Chromium Playwright：7/7；
- Vinext production build：通过，包含 `/api/runs` 和 `/api/runs/:id/step`；
- `git diff --check`：通过。

正式 Git commit、GitHub Actions、Sites version 和线上真实贪吃蛇数据将在本轮部署验收完成后补在本节。

### 首次生产验收发现的问题（Sites v22）

- v0 真实性通过：新贪吃蛇项目只显示 `VERSION 0 · NO GENERATED APP`，发布/下载禁用，必须显式点击“开始正式构建”；
- Iris 真实生成 8 个功能/12 条验收标准，Bob 生成 12 个状态约束/12 条测试策略，两类 Artifact 均持久化；
- Alex `index.html` 三次尝试均收到约 10K–14K 实时字符，但 Luna/备用输出越界包含 CSS/JS，窗口结束仍未完整关闭；
- Run 产生明确失败终态，只保留 2 个上游 Artifact，代码 0/3、Version v0、发布/下载继续禁用，没有拿 Todo Demo 冒充成果；
- 这次证据推动按角色模型路由、代码 34 秒主窗口和更强单文件协议，修复后将发布下一 Sites version 再复测。

### v23–v25：协议门、完整流与最终生产通过

- commit `a74323661e4b703bd69dc7f3b814cc1b96bd9472` 将代码动作路由为 `glm-5.2 → gpt-5.6-luna`，发布 Sites v23；生产复测发现 Bob 架构仍允许把 CSS/JS 内联到 HTML，Alex 因矛盾交接再次生成单文件全家桶；
- commit `68ae3179319380e2a69564dd8bef296463083358` 增加不可变文件职责、工件协议门和 SSE 完整结束检查，发布 Sites v24 / env revision 7；线上协议门正确阻断三次污染，但也暴露把外部 `<script src="script.js">` 误判为内联代码的问题；
- v24 失败 Run 只保存 Iris/Bob 两个上游工件，代码 0/3、Version v0、发布/下载禁用，证明失败不会污染成品；
- commit `efa0957d4681bd87a555e218a258fdb2ae061842` 在保存前移除由平台重复注入的 `styles.css` / `script.js` 引用，同时继续阻断真正内联代码；Sites v25 发布成功，环境 revision 7；
- v25 同一贪吃蛇需求第一轮 HTML 因 Markdown 残留被拒绝，下一阶段尝试自动重试并保存 6KB HTML；CSS 15KB、JavaScript 21KB 均建立独立检查点，JavaScript 通过 Acorn；
- Ray 前两轮因模型超时/未正常结束保留工件并重试，第三轮通过：15 条功能证据、确定性质量 100/100、A 级，仅保留两条非阻断触屏建议；
- 最终 Run `f0da0a18…`：`completed`，291 秒，105,797 Tokens，14 次模型调用，14 条 ModelAttempt；`success`、`timeout`、`incomplete` 均在工作台逐条可见；
- 实际浏览器验收：公开页 Start 后可用 Space 暂停为 `Paused`、再次 Space 恢复为 `Running`、方向键可输入、`R` 重开后为 `Running` 且分数归零；成功版本运行期间没有新增 Console error；
- v1 已发布到 <https://www.llynb.cc/p/responsive-snake-game-d1bf0e>，项目工作台为 <https://www.llynb.cc/w/d1bf0eb6-4b74-48d0-984e-ebaa773cbb3c>；
- 最终本地门禁：Vitest 41/41、Playwright 7/7、TypeScript、ESLint、Vinext production build 和 `git diff --check` 全部通过。
- GitHub Actions `verify` 对提交 `efa0957…` 通过（Linux 构建与 Chromium 测试）。

## 第十二轮：P2/P3 全栈应用平台与 Lovable 式差异化能力

### 每个生成应用的运行资源

- Bob 的结构化工件新增 Runtime Blueprint；保存 Version 时生成不可变 AppManifest，声明每应用 API、集合 Schema、Auth 模式、依赖、Backend Function 和验收标准；
- 新增按 `project_id + collection` 强制隔离的 D1 应用数据层、Schema 白名单校验、32KB 单记录上限和 revision 乐观并发控制；
- 预览与公开应用分别签发哈希化 Access/Refresh Session，工作台 Session 继承组织角色；
- iframe 注入 `window.nucleus.data.list/create/update/remove`、Auth、能力清单和日志 SDK；
- 新增运行时证据、最多 5,000 条/约 1.8MB 应用数据备份、恢复前自动检查点和分批 D1 恢复；
- migration `0007_robust_gravity.sql` 新增 Manifest、Session、Record、Evidence、Backup、Runner、Race、Organization、Approval、Usage 和 Git Integration 表。

### Race、视觉编辑与自动修复

- Race Mode 对可用代码模型并发请求，按 HTML/CSS/JavaScript 的语义、响应式、可访问性、真实交互和 Runtime API 使用确定性评分；
- 每个候选模型、输出长度、得分和是否入选写入 `race_candidates`，最终候选仍须通过 Ray；
- iframe Element Picker 返回稳定 selector、计算样式和尺寸；工作台支持即时 Patch，但只有重新进入正式多 Agent Run 并通过 Ray 的修改才会保存为 Version；
- Console、error、unhandledrejection、DOM 摘要和云端 Runner 证据写入 D1；每个版本最多自动回灌 Ray 一次，Runner 失败由原子 claim 防止重复修复。

### 外部 Runner、Git 与组织控制面

- GitHub Actions workflow_dispatch + `scripts/cloud-eval.mjs` 可访问真实公开 URL、执行安全点击、收集 Console/page/network/截图并签名回调；未发布应用返回 409；
- 外部 Container Runner 协议可接收源码、npm/pip/system/container 依赖、Backend Function 和 CPU/内存/磁盘/网络限制；Worker 本身不执行任意 Docker；
- Git Data API 自动建立 Iris/Bob/Alex/Ray 链式分支和 commit，并把最终 Ray 分支合并到默认分支；
- 新增组织成员/邮箱邀请认领、owner/admin/editor/reviewer/viewer RBAC、发布审批、月 Token 硬预算和用量事件；
- Git、Playwright、Container 在缺少服务端 Provider 凭据时统一显示 `configuration-required`，不伪装成功；邀请当前只落后端状态，不发送邮件；用量控制不是完整支付计费。

### 第十二轮本地发布门

- Vitest：70/70；
- 固定 AppManifest Eval：25/25；
- Chromium Playwright：7/7；
- TypeScript：通过；
- ESLint：通过；
- Vinext production build：通过，识别 26 条页面/API 路由；
- `scripts/cloud-eval.mjs`：Node 语法检查通过；
- 大规模端到端生成成功率 Eval 尚未完成，因此 25/25 不能解释为任意应用生成成功率。

### 新增教学文档

- `docs/learning/14-p2-p3-full-stack-platform.md`；
- `docs/learning/15-race-visual-runner-git.md`；
- `docs/learning/16-team-operations-observability.md`；
- `docs/learning/17-p2-p3-deployment-acceptance.md`。

## 第十三轮：商业控制面基础与最终 GitHub 交付

- 新增可选物理 D1 Provisioner，覆盖创建、Schema Migration、资源状态、Time Travel 书签、保留期删除与审计；默认逻辑 D1 路径保持兼容；
- 新增 GitHub App 安装/OAuth state 校验、安装归属验证、RSA JWT 和短期 Installation Token；
- 新增 Stripe Checkout、Billing Portal、原始请求体 HMAC Webhook、事件幂等与 Meter Usage 导出；
- 新增邮件通知 Provider、生产维护端点与 GitHub Actions 定时触发、服务事件和 SLO 评估；
- 新增固定产品/安全 Eval 与只读并发负载测试脚本，并补强移动端工作台布局；
- 所有外部商业 Provider 均采用显式配置状态：仓库包含可执行集成代码，但未配置真实凭据时不会声称已经开通对应云服务。

### 最终本地交付门

- Vitest：201/201；
- 固定产品与安全 Eval：155/155；
- Chromium Playwright：7/7；
- TypeScript：通过；
- ESLint：通过；
- Drizzle schema/migration consistency：通过；
- Vinext production build：通过；
- `git diff --check` 与通用密钥扫描：通过。

## 第十四轮：可恢复商业 Provider、长期归档与移动端安全加固

### Provisioner 与数据库生命周期

- 正式 Version 保存后自动登记 `desired_schema_version`，并通过 Vinext Request ExecutionContext 的 `waitUntil` 异步触发独立 D1 创建；小时维护任务作为可靠兜底；
- 新增稳定数据库 Schema Digest，只有集合/字段契约改变才迁移，纯 UI 修改不会无意义重建数据库；
- Provisioner 新增四分钟租约、卡死回收、失败次数、下次重试时间和指数退避；`pending/error/configuration-required` 可被 Reconciler 自动恢复；
- 旧逻辑数据改为 500 条分页迁移，并在创建完成后回放并发窗口；`ON CONFLICT ... DO UPDATE WHERE excluded.revision > current.revision` 防止旧数据覆盖新 Revision；
- 删除任务不再因缺少 Cloudflare Token 误删控制面状态；延迟删除失败保留任务并由维护任务重试；
- migration `0009_harsh_bloodstorm.sql` 新增 Provisioner 重试字段、备份归档字段、通知 Outbox 字段、发票和运维告警表。

### 备份、通知、账单和运维

- 物理 D1 先创建 Time Travel Bookmark；绑定 `ARCHIVE` R2 后，通过 D1 Export polling 获取 SQL 并流式写入对象存储；逻辑 D1 以 JSON 归档；
- 过期备份先删除 R2 Object，再删除控制面行；对象清理失败时保留元数据，避免产生无法追踪的数据残留；
- Resend 邀请邮件改为 Outbox-first，保存 Payload、Attempts、Next Attempt、Last Attempt，并使用稳定 Idempotency-Key；
- Sentry/Webhook 告警增加持久化 Outbox、Fingerprint 冷却去重、HTTP 状态检查和失败重试；SLO 同时检查可用性和 P95；
- Stripe Webhook 修复组织 ID 解析范围，新增 Invoice 镜像、Hosted Invoice/PDF、支付失败/成功状态和 Fail-closed 权益同步；取消、暂停、未支付会把组织降为 Demo；
- GitHub App Installation Token 成为默认路径，`GITHUB_AUTOMATION_TOKEN` 只有显式设置 `NUCLEUS_ALLOW_LEGACY_GITHUB_PAT=true` 才能回退。

### Runner、移动端、安全与压测

- Playwright/容器 Runner 回调增加 Bearer + 原始 Body HMAC + 五分钟时钟窗口；Job 只有 queued/running 能进入终态，重复回调返回 409；
- Sandbox Policy 增加本地/Workspace 依赖、额外 pip Index、实例元数据 SSRF、Docker Socket、Node 子进程和 `file://` 防护测试；
- DOM Picker 从 mouseover 升级为 pointerover + touchstart + click target fallback；移动底部面板新增高度、Margin、Display 和 Grid Columns；
- 固定产品语义语料从 120 扩到 240；新增真实本地 D1 控制面 E2E 和 390×844 Touch E2E；
- `scripts/load-test.mjs` 支持多 Cookie 用户池、JSON 场景、显式写开关、Expected Status、失败率和 P95 门槛；
- 实际本机开发 Worker 压测 1,000 请求/40 并发，1,000 成功、0 失败、36.48 RPS、P95 2162.62ms、P99 4158.84ms。该结果不是生产 SLA。

### 第十四轮发布门

- TypeScript：通过；
- Vitest：16 文件，340/340；
- 固定产品与安全 Eval：3 文件，283/283；
- 专项安全：17/17；
- Chromium Playwright：9/9；
- ESLint：通过；
- Vinext production build：通过；
- Drizzle：成功生成并检查 `0009_harsh_bloodstorm.sql`；
- 新增完整教学：`docs/learning/19-commercial-hardening-and-provider-runbook.md`。

仍需外部资源的项目保持诚实边界：托管 gVisor/Kata 集群、GitHub App 注册、Stripe 商户/价格、Resend 验证域名、Sentry 项目、Cloudflare Provisioner Token 和第二云厂商跨区域 DR 都不能仅凭仓库代码宣称已经在线。

## 第十五轮：生产生成故障复盘与工件级恢复

- 从真实失败 Run 确认：总预算为 180,000 Tokens/24 Calls，实际仅使用 15,060 Tokens/10 Calls；失败并非预算耗尽；
- Bob 曾收到 HTTP 200、3,905 字符的不可解析 JSON，备用模型多次返回 3,000–4,000 字符但缺少 SSE 终止事件，旧编排因此重复执行整个 Bob 阶段三次；
- 对照 OpenCode Go 当前官方端点后确认旧网关还存在协议错配：`gpt-5.6-luna` 过去错误走 `/chat/completions`；现在 GPT 改走 `/responses`，GLM 保持 `/chat/completions`，两种 SSE、完成状态和 Token 用量统一归一；
- 新增 `structured-output.ts`，用平衡括号扫描和受限尾逗号修复解析 JSON，不执行模型文本；代码工件只有完整 Markdown Fence 且通过文件协议才可救回；
- `model-gateway.ts` 区分明确 `finish_reason=length` 与“缺终止事件但工件完整”，后者标记 `recovered` 并保留完整审计；流末尾超时时也可救回已完成工件；
- Iris、Bob、Ray 增加保守确定性恢复；恢复事件显式入库，Alex 仍必须生成真实代码，最终质量门不可跳过；认证/限流等纯 HTTP 错误不会伪装为成功；
- 中文打字测试增加输入/输入法、正确率与 WPM、随机题库、成绩与重试四项阻断契约；
- 工作台模型明细开始显示每次尝试的真实错误和 `recovered` 状态；同批 Attempts 使用单调时间戳，界面顺序与真实调用顺序一致；
- 新增完整教学 `docs/learning/20-why-unlimited-tokens-do-not-fix-generation.md`。

### 第十五轮本地门禁

- TypeScript：通过；
- Vitest：17 文件，351/351；
- 固定产品与安全 Eval：283/283；
- ESLint：通过；
- `git diff --check`：通过；
- Chromium E2E：9/9；
- Vinext production build：通过。

## 第十六轮：引导式需求、实时构建、超时终态与严格沙箱持久化

日期：2026-08-13。

### 用户流程与实时反馈

- 新增项目级 `intake_json` 和 migration `0010`；首页卡片或自定义需求进入工作台后，Iris 真实生成恰好三个产品方向，其中一个推荐；
- 用户选择方向后，系统把方向详情扩展进正式 Prompt 并自动创建 Run，不再要求点击第二个“开始正式构建”；
- 右侧重复黑色输出框替换为 `LiveBuildMonitor`：实时展示 Agent、阶段、用时、三文件状态、真实代码尾部、模型和累计字符；
- 左侧对话增加字号与可读信息，保留 Agent 步骤、Artifact、Ray 质量门和完整审计；失败原因新增直接可见的 `role="alert"` 卡片，不再只藏在折叠审计；
- 候选预览按 1/3、2/3、3/3 文件渐进更新；没有 Ray 通过时仍为 v0/候选，不会用旧 Demo 冒充成功。

### 真实延迟与终态修复

- 生产财务应用生成确认 GLM 代码首个可见 Token 可能超过 75 秒，旧首片超时会过早切断；
- 生产环境和默认配置调整为代码首片 140 秒、单请求 175 秒、备用预留 70 秒；Run 上限 60 Calls/500K Tokens，单阶段 4 Calls/100K Tokens/280 秒；
- 阶段路由 deadline 调整为 285 秒；即使 AbortSignal 已触发，也必须写失败/终止事件、输出终态并关闭响应，不再让页面永久停在“连接中”；
- 财务 CRUD 人工新增 `¥88.66` 后统计与明细正确，但发现 CSS 强制 `display:flex` 覆盖 `[hidden]`；新增 `finance-hidden-visibility` 阻断门，后续同类错误不能进入 Version。

### 严格 iframe 数据持久化

- 看板真实生成和流转通过，但刷新丢失任务，确认根因是严格 iframe 不含 `allow-same-origin`，原生 `localStorage` 不可用，旧 shim 仅存内存；
- 拒绝通过增加 `allow-same-origin` 换取方便，因为它与 `allow-scripts` 组合会扩大生成代码访问宿主的风险；
- 新增 `lib/preview-storage.ts` 和 runtime 宿主桥：只接受当前 iframe 的 `nucleus-preview/storage` 消息，按项目隔离并限制 200 keys、256 字符 key、50K 单值、1M 总量；
- 工作台刷新会用宿主可信快照重建 opaque iframe 存储；公开页与工作台使用同一 projectId 数据空间；跨设备共享仍使用每应用 API/Schema/Auth，不混淆为云数据库；
- 新增 Playwright 回归：生成应用写 `localStorage` 后点击工作台刷新，值仍存在，且 iframe sandbox 仍不含 `allow-same-origin`。

### 四类生产真实生成与点击验收

- 中文打字：Iris 三选一后自动构建；首次 HTML 因三文件职责污染被拒，重试 v1、Ray 100/A；实际键盘输入更新到 `10/40`，正确率变化，粘贴阻止和重新开始归零通过；
- 极简番茄钟：第一轮失败保留，重试 v1、Ray 100/A；实际新增任务、启动、暂停、继续、结束确认、标记完成，今日完成 `0→1`；
- 轻量看板：第一轮未过门，重试 v1、确定性 Ray 100/A；新建任务后计数 `1/0/0→0/1/0→0/0/1`；刷新丢失问题推动上述持久化修复；
- 贪吃蛇：v1、Ray 100/A；开始、暂停、继续、重开、键盘方向、吃食得分 10、撞墙结束、移动端触控和最高分保持通过；
- 以上均为新建生产项目和真实模型 Run，没有使用预制 Demo；首次失败、协议拒绝、模型审查不可用和重试记录均保留。

### 第十六轮本地发布门

- Vitest：18 文件，363/363；
- 固定产品与安全 Eval：3 文件，283/283；
- 专项安全：17/17；
- Chromium Playwright：11/11；
- TypeScript：通过；
- ESLint：通过；
- Vinext production build：通过；
- `git diff --check`：通过；
- 完整教学新增：`docs/learning/21-guided-intake-live-cockpit-and-production-eval.md`。
