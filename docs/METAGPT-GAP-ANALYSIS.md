# Nucleus 与 MetaGPT / Atoms 的差距分析

审计日期：2026-08-10

## 结论

三个对象不能用一个百分比简单比较：

- **MetaGPT** 是通用 Python 多智能体开发框架；
- **Atoms** 是建立在 MetaGPT/MGX 之上的商业产品；
- **Nucleus** 是笔试范围内持续迭代的可运行 AI 应用生成器，不是 Atoms 源码复刻。

按完整商业产品广度比较，Nucleus 目前仍约覆盖 Atoms 的 **30%–40%**；按 MetaGPT 通用框架广度比较约 **35%–40%**。正式可恢复链路显著提高了“需求→架构→实现→审查→修复→版本”这条开发主链的深度，但没有凭空补齐全栈容器、浏览器 Agent、支付、多人协作和商业基础设施。按本次笔试五项 rubric，它已具备高分作品的工程代理特征；具体分数必须以最新线上真实生成和评审为准。

这里的分数是基于公开功能和题目 rubric 的工程估算，不是统计学上的候选人百分位。没有全部候选作品数据，不能诚实承诺“必然超过 90% 面试者”；可以把 90 分以上、无 P0 缺陷、线上主链路全通作为“前 10% 竞争力”的代理目标。

## 官方来源与审计基线

- MetaGPT 官方仓库：<https://github.com/FoundationAgents/MetaGPT>
- 本地审计提交：`11cdf466d042aece04fc6cfd13b28e1a70341b1f`
- 许可证：MIT
- 审计时约 69,700 stars、507 个 Python 源文件、248 个测试文件
- Atoms 官方产品沿革：<https://atoms.dev/zh/metagpt>
- Atoms 当前能力说明：<https://atoms.dev/mgx-is-now-atoms>

MetaGPT 源码下载在仓库外的 `upstream/metagpt` 学习目录中，没有直接复制进 Nucleus。

## MetaGPT 真正值得学习的部分

### 1. Role 不是头像，而是状态机

MetaGPT 的 Role 会：

1. 订阅特定 Action 产生的 Message；
2. 从消息缓冲区观察新消息；
3. 根据固定 SOP、ReAct 或 Plan-and-Act 决定下一步；
4. 执行 Action；
5. 把带 `cause_by`、`sent_from`、`send_to` 的 Message 发布回 Environment；
6. 保存记忆并等待下一轮。

Nucleus 原版本中 Bob/Ray 主要是 UI 叙事。当前版本已经把固定 SOP 做成持久化状态机：Iris、Bob、Alex、Ray 分别进行真实模型调用，消费上游 Artifact，产生独立 Artifact/Attempt/Event，并按 `current_stage` 交接。它仍不是 MetaGPT 的通用消息订阅、动态角色注册或任意 Environment 调度框架。

### 2. Action 产生可审查工件

MetaGPT 不只传自然语言，它把需求、PRD、系统设计、任务列表、代码、测试和运行结果做成独立工件。后续角色消费的是明确产物，而不是无限增长的一段聊天。

Nucleus 当前已经有 requirements、architecture、HTML、CSS、JavaScript、quality 六类检查点，另有 ModelAttempt、AgentEvent 和 Version。仍缺少通用任务 DAG、仓库级测试文件、命令执行结果和跨分支合并工件。

### 3. QA 是闭环

MetaGPT 的 QA 观察代码变化，编写测试、运行测试、分析错误并进入有限轮次的修复。它有 `test_round_allowed` 防止无限循环。

Nucleus 当前同时执行 9 项通用确定性门、应用类型专项门和 Ray 语义审查；阻断时最多两轮定向修复并重新审查。与 MetaGPT 的差距是它还不能为任意技术栈编写并执行真实测试套件，也没有云端浏览器自动验收每一个生成版本。

### 4. Environment、预算与恢复

MetaGPT Team 通过 Environment 路由消息，通过 `n_round` 限制轮次，通过 investment/cost manager 限制预算，并支持序列化后恢复。

Nucleus 现有 Run 级调用/Token 硬预算、阶段级时间/主备预算、最多两轮修复、D1 检查点、双层租约和断点恢复。仍没有 MetaGPT 的通用消息路由、并行任务 DAG、动态投资分配和可插拔工具环境。

## 功能矩阵

| 能力 | MetaGPT / Atoms | Nucleus 优化前 | 第一轮优化后 |
|---|---|---|---|
| 产品规划 | PRD/研究/结构化产物 | 一次 AgentPlan | 保持 |
| 架构设计 | 独立 Architect Action | 计划中的 design 字段 | 保持，后续独立化 |
| 代码生成 | 多文件、工具与仓库操作 | HTML/CSS/JS 三文件 | 保持安全边界 |
| Agent 消息 | 订阅、路由、cause_by | UI 状态事件 | 增加结构化 review 事件 |
| QA | 写测试—运行—修复循环 | 完整性、运行错误 | 9 项质量门 + 定向修复 |
| 语法验证 | 工具执行/测试 | 生成后人工发现 | Acorn ECMAScript 解析 |
| 安全验证 | 工具与策略 | sandbox + 大小限制 | 增加危险调用阻断 |
| 质量持久化 | 工件、测试结果 | 无 | 每个 Version 保存评分 |
| 预算控制 | investment/cost manager | 每小时次数限流 | 保持，待加 token/cost |
| 状态恢复 | Team 序列化 | 版本快照 | 已有前端版本恢复 |
| 后端生成 | Atoms 支持 | 不支持 | 不盲目扩范围 |
| Auth/支付 | Atoms 支持 | 不支持 | 下一优先级为项目所有权 |
| 多方案竞赛 | Atoms Race Mode | 不支持 | 后续可做轻量双候选评审 |
| 自动化检查 | 大型测试体系 | 本地 6 tests | 10 tests + GitHub CI |
| 部署 | Atoms 一键发布 | Sites/Worker/D1 | 已有真实公网部署 |

## 第一轮优化：MetaGPT-inspired Ray Quality Gate

新增确定性检查：

1. JavaScript 是否能通过 ECMAScript 语法解析；
2. 是否包含 `eval`、动态 Function、`document.write` 或跨窗口 DOM；
3. 是否同时存在交互控件和事件处理；
4. HTML 是否有语义结构；
5. 是否有移动 viewport；
6. CSS 是否有响应式规则；
7. 表单控件是否有可访问名称；
8. 是否有键盘焦点样式；
9. 是否依赖外部脚本或样式。

质量门会给出 0–100 分和 A–D 等级。语法、安全或真实交互失败会阻止保存；系统把具体问题交给 Ray 做一次定向修复，再重新执行全部检查。只有最终通过的生成物才能成为新版本。

报告通过 NDJSON `review` 事件发送到工作台，并作为 `quality_json` 保存到 D1 的每个版本。版本历史因此不仅回答“什么时候生成”，还回答“交付前验证了什么”。

## 笔试评分估算

| 维度 | 题目关注点 | 原版本 | 第一轮后 | 继续提升点 |
|---|---|---:|---:|---|
| 完成度 | 功能、稳定、工程质量 | 18/20 | 19/20 | 所有权、并发 |
| 工程思维 | 拆解、选型、复杂度 | 17/20 | 19/20 | 消息元数据、成本 |
| 用户体验 | 清晰、顺畅、可用 | 17/20 | 18/20 | 取消、详细 QA 面板 |
| 创新性 | 亮点、视角、扩展 | 15/20 | 17/20 | Race/自动浏览器 QA |
| 可交付性 | 文档、运行、完成质量 | 18/20 | 19/20 | CI 状态、E2E |
| **合计** |  | **85/100** | **92/100（目标估算）** | 用线上证据校准 |

92 分的前提是新增 migration、CI、生产部署和真实生成都通过；在完成线上验收前，只能称为候选分数。

## 后续路线图

### P0：消除会被资深面试官抓住的缺陷

1. 匿名 workspace / 登录所有权：不能让所有访客读取和修改全局项目；
2. 生成并发控制：同一项目只允许一个 active generation；
3. 固定版本发布：公开页指向 `published_version_id`，修改草稿不应静默改变线上；
4. 请求超时与取消：用户能停止长生成，服务端中止模型请求；
5. 自动 E2E：创建、生成、恢复、发布进入 Playwright smoke。

### P1：强化 MetaGPT 式工程工件

1. 把 Bob 独立为 Architecture Artifact，而不是状态文案；
2. 给每个 AgentEvent 增加 event ID、cause、duration 和 model usage；
3. 保存 generation run、每一步输入摘要、输出、耗时和失败原因；
4. 请求级 token/费用预算与最多修复轮数；
5. 运行日志与用户可下载的交付报告。

### P2：形成真正有辨识度的创新

1. 轻量 Race Mode：两个候选只生成关键方案，质量门选择胜者；
2. 浏览器 QA：自动点击主控件、捕获 console 和截图；
3. 视觉回归和可访问性自动检查；
4. 发布前质量阈值可配置；
5. 生成应用的受控持久化 API。

## 第二轮更新：P0 已闭环

第一轮之后列出的五项 P0 已在第二轮完成：

1. 匿名 HttpOnly 会话所有权覆盖列表、读取、生成、恢复和发布；
2. 原子 generation lease 阻止同项目并发生成，并允许超时租约回收；
3. `published_version_id` 将公开页固定到明确版本，草稿迭代不会改变线上内容；
4. 工作台取消操作把 AbortSignal 传递到上游模型请求，并按 generation ID 安全释放状态；
5. Playwright 在真实浏览器中覆盖创建工作台、NDJSON Agent 事件、Ray review 与版本完成状态。

数据库同时增加版本号唯一索引，GitHub Actions 增加 Chromium E2E。完成本地与线上验收后，按题目 rubric 的工程代理分可从第一轮约 92/100 调整为约 **95/100**。这仍不是统计学百分位承诺；更准确的说法是：已消除大多数短时笔试常见的全局数据泄露、并发覆盖、发布漂移和“只有单测没有用户链路”四类硬伤。

下一阶段从 P0 转向 P1：优先保存 generation run、Agent 事件元数据、耗时与模型用量，使 MetaGPT 式协作从 UI 时间线进一步变成可审计工件。

## 第三轮更新：P1 执行审计已落地

第二轮提出的最高优先级 P1 已完成：

1. 每轮生成建立持久化 `GenerationRun`，记录模型、状态、耗时、Token、调用次数、修复次数、版本和错误；
2. Iris、Bob、Alex、Ray 的阶段输出成为有 ID、有顺序、有 phase 和 usage 的 `AgentEvent`，不再只是易失的 UI 文案；
3. OpenCode Go 的 usage 跨重试、补文件和质量修复调用聚合，工作台可展开查看最近一轮运行证据；
4. 成功、失败、用户取消、配额拒绝和租约过期都有明确终态；终止后的迟到事件与版本写入会被数据库条件拒绝；
5. 审计查询按实际访问路径建立索引，公开页和项目列表不加载私有运行轨迹。

这使 Nucleus 在“工件可追踪”和“预算可观察”两项上明显接近 MetaGPT 的工程思想，但仍不等同于 MetaGPT 的通用 Role/Action/Environment 调度，也没有 Atoms 的全栈容器、账号计费、浏览器 Agent 和多人协作。按本笔试 rubric 的工程代理分可谨慎上调到约 **96/100**；这仍是有依据的自评，不是候选人百分位统计。

## 不应该做的事

- 不要把 MetaGPT 的 Python 依赖直接塞进 Worker；
- 不要为了“多 Agent”把一次调用拆成五次昂贵但无独立产物的调用；
- 不要在笔试中开放任意后端代码执行；
- 不要复制 Atoms 私有产品界面或声称其商业功能已开源；
- 不要用 star 数代替架构判断；
- 不要承诺无法由候选作品数据证明的精确百分位。

最优秀的笔试作品不是功能最多，而是范围明确、主链路可靠、关键风险有防线、每个取舍都能解释，并且在线证据与源码一致。

## 第四/五轮更新：预算、账号与断流恢复已落地

此前 P1 中的请求级预算和账号升级已经完成：

- Iris 规划使用本地确定性 SOP；构建、补文件和 Ray 修复共享调用、Token 和时间预算，主备模型按可解释规则切换，最终模型链持久化；
- Sign in with ChatGPT 建立稳定账号 owner，匿名项目可迁移，项目、版本、对话和成品链接跨设备保存；
- 预览新增沙箱启动校验；浏览器长流断开时读取服务端状态并自动恢复，不会重复发起后台任务；
- 该轮当时的 30 个单测、4 个 Chromium E2E、GitHub CI 和生产登录/取消链路均已通过；当前基线见文末能力校正与 `PROGRESS.md`。

因此 MetaGPT 主要剩余差距已不是“有没有多个角色头像”，而是通用 Role/Action/Environment 调度、动态任务依赖、并行分支和更广的工具执行。与商业第一梯队相比，最大差距是生成应用独立后端、云端浏览器 Agent、元素级编辑和 Git 项目协作。完整对照和五级上限定义见 `UPPER-BOUND-BENCHMARK.md`。

## 2026-08-10 当前能力校正

| 能力 | 当前是否真实落地 | 证据边界 |
|---|---|---|
| 真实角色调用 | 是 | Iris、Bob、Alex、Ray 均独立调用模型，不只是头像动画 |
| 结构化交接 | 是 | requirements → architecture → 三文件 → quality Artifact |
| 断点恢复 | 是 | `current_stage`、Artifact upsert、项目/阶段双租约；刷新从同一 Run 继续 |
| 预算 | 是 | Run 24 calls/180K Tokens；阶段 2 calls/40K/47s；达到硬上限终止 |
| 审计 | 是 | 每次模型尝试记录状态、耗时、首字、字符、usage、错误和模型链 |
| QA 闭环 | 部分但真实 | 通用门 + 应用类型门 + 模型审查 + 两轮修复；尚无生成物云端浏览器自动点击 |
| 代码范围 | 受控 | 仅 HTML/CSS/JS 三文件，无任意依赖/后端执行 |
| 动态调度 | 否 | 固定 SOP，不是通用 Role/Action/Environment |
| 并行方案/分支 | 否 | 同项目单写优先一致性，尚无 Race Mode 和人工 merge gate |
| 全栈产品工厂 | 否 | 平台本身有 D1/Auth/部署，生成应用没有独立数据库/Auth/API |

所以面试中最准确的表达是：Nucleus 已经把 MetaGPT 的“角色、工件、有限 QA 循环、预算和恢复”工程思想落到一条受控前端应用生成链上；它不是完整 MetaGPT 框架，更不是 Atoms 商业产品的 1:1 复刻。
