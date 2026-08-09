# AI 应用生成器上限基准与真实 Demo 证据

审计日期：2026-08-09

## 结论先行

这类产品的真正上限不是“把一句话变成一张漂亮页面”，而是把自然语言持续转换为一个可运行、可验证、可恢复、可部署、可协作维护的软件系统。

Nucleus 当前已经跨过静态 PoC：它能生成真实交互、保存账号项目与对话、建立版本、公开发布、记录模型用量与 Agent 事件，并在沙箱中报告启动错误。它仍没有达到 Lovable、Bolt、Replit Agent、v0 或 MGX 的商业产品上限，主要差距是“每个生成应用独立后端/数据库”“任意依赖与全栈运行沙箱”“浏览器自动操作测试”“可视化局部编辑”和“Git 分支协作”。

更诚实的定位是：

- **Nucleus 平台本身：L3 持久化在线工作区**；
- **Nucleus 当前生成物：L1-L2 之间的自包含交互应用**；
- **商业第一梯队：L4，少数工作流正在接近 L5**。

## 五级能力上限

| 级别 | 判定标准 | 典型失败方式 |
|---|---|---|
| L0 概念展示 | 静态截图、假进度或不可操作 UI | 只能“看”，不能验证 |
| L1 可运行工件 | 代码能启动，核心控件真实可用 | 没有质量、恢复和长期状态 |
| L2 可验证迭代 | 自动检查、运行反馈、继续修改、版本回滚 | 浏览器断流或模型失败后容易丢任务 |
| L3 持久化产品工作区 | 登录、跨设备项目/对话、审计、固定版本发布 | 生成物仍受单一运行时边界限制 |
| L4 全栈产品工厂 | 为生成应用配置 Auth、数据库、API、密钥、域名和生产部署 | 成本、安全和迁移复杂度高 |
| L5 自主软件团队 | 并行任务/分支、测试、代码评审、观测、自动修复与合并 | 需要严密授权、预算和人类审批 |

## 官方产品能力对照

以下只使用官方仓库或官方文档；借鉴能力模型，不复制闭源产品代码或界面。

| 产品 | 官方证据 | 最值得学习的上限能力 | Nucleus 当前状态 |
|---|---|---|---|
| MetaGPT | <https://github.com/FoundationAgents/MetaGPT> | SOP 驱动的产品经理/架构师/工程师角色、结构化工件、轮次和成本预算 | 已实现固定角色阶段、结构化计划、GenerationRun/AgentEvent、调用/Token/时间预算；不是通用 Role/Action/Environment 框架 |
| MGX | <https://mgx.dev/usecases/Build-Your-SaaS-Landing-Page-with-AI/> | 多 Agent 讨论、实时渲染、分支/撤销、一键部署、Supabase、可视化局部编辑 | 已有 Agent 时间线、预览、回滚和发布；缺少 Supabase 生成和元素级编辑 |
| Lovable | <https://docs.lovable.dev/features/testing> | 真实浏览器点击/表单/截图/网络/控制台验证，前端与 Edge Function 测试 | 已有 9 项确定性质量门、Playwright 产品 E2E、运行错误桥和启动校验；尚未在云端自动点击每个生成物 |
| Lovable | <https://docs.lovable.dev/integrations/github> | GitHub 双向同步、分支测试、可自托管 | Nucleus 源码走 GitHub PR/CI；单个用户生成项目还没有独立 Git 仓库 |
| Bolt | <https://support.bolt.new/building/intro-bolt> | 数据库、Auth、密钥、边缘函数、用户管理、托管统一在一个工作区 | Nucleus 平台有 D1 和登录，但生成应用没有独立数据库/Auth |
| Replit Agent | <https://docs.replit.com/references/version-control/checkpoints-and-rollbacks> | Checkpoint 同时保存文件、对话上下文、环境、Agent 记忆和数据库 | Nucleus 保存文件版本、对话、运行审计；没有环境/生成应用数据库快照 |
| Replit Agent | <https://docs.replit.com/core-concepts/agent/task-system> | 隔离分支上的后台并行任务，完成后查看日志/测试/预览并选择合并 | 当前同项目严格单写，优先一致性；没有并行分支与人工合并门 |
| v0 | <https://v0.dev/docs/full-stack-apps> | Next.js 全栈、API routes、数据库和 Marketplace 集成 | 当前主动限制为自包含三文件前端，换取低冷启动和更清晰安全边界 |
| v0 | <https://api2.v0.dev/docs/faqs> | Git 分支/自动提交/PR、完整编辑器、生产同构预览 | Nucleus 有代码查看/ZIP/PR/部署，但没有生成项目级 Git 和完整 IDE |

## Nucleus 实测协议

每个基准不是只看截图。必须记录：

1. 从创建到版本保存的生产耗时；
2. 模型、Token、模型调用数和 Agent 事件数；
3. Ray 质量分与 9 项检查结果；
4. 沙箱是否回报“启动校验通过”；
5. 至少完成一个核心用户操作；
6. 发布为固定版本公开链接；
7. 失败时是否能取消、恢复或留下可解释终态。

## 已测生产样本

| 场景 | 结果 | 生产证据 | 实际操作 |
|---|---|---|---|
| 面试项目冲刺看板 | 21 秒；6,293 Tokens；1 次模型调用；11 事件；`glm-5.2`；Ray 100/A | <https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site/p/app-0bd184> | 新增高优先级“补齐系统设计演示”，搜索后从待办流转到进行中、已完成；总数 4→5，完成率 25%→20%→40%；沙箱启动通过 |
| BudgetLens 财务 CRUD | 38 秒；7,470 Tokens；2 次模型调用；11 事件；`glm-5.2`；Ray 100/A | <https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site/p/budgetlens-4e9b1d> | 新增 123 元“基准测试餐费”后，记录与统计实时更新；沙箱启动通过 |
| 面试准备清单 | 18 秒；4,954 Tokens；2 次调用；11 事件；Ray 100/A | <https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site/p/app-6e0e9a> | 新增任务、键盘勾选、完成筛选，进度从 0/1 更新到 1/1 |
| 习惯打卡器 | 正式环境完成 v1 并发布 | <https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site/p/app-c4fbb7> | 三文件齐全，公开页 HTTP 200 |

## 故障样本与产品改进

复杂看板和打字挑战首次测试时，浏览器流在长模型阶段出现 `network error`，服务端租约仍在运行。这个结果没有被删掉或包装成成功，而是推动了两项修复：

- 流每 8 秒写入透明心跳，并发送 `no-cache/no-transform` 与禁缓冲响应头；
- 浏览器断流后读取服务端项目状态，显示“连接恢复中”，轮询同步最终版本，并始终保留取消按钮；重新打开工作台不会重复提交同一生成任务。

对应自动回归已经覆盖“页面打开时服务端任务仍在运行，随后完成并自动恢复结果”，且验证不会再次 POST `/api/generate`。

心跳和恢复改善了断流后的体验，但不能缩短上游模型本身占用的时间。Nucleus 因此把 Iris 规划改成确定性本地 SOP：保留结构化计划与 Agent 审计工件，规划耗时降到毫秒级、零 Token；正常新建应用只需一次代码模型调用。部署后同题复测确认 Iris 从 27 秒降到 0ms，但 Qwen 的复杂三文件输出仍越过长连接窗口，因此代码主模型按真实场景延迟改为 GLM，Qwen 留作故障降级。同题最终在 21 秒完成，且真实新增、搜索、两次流转和统计更新全部通过。

## 成功率如何表达

目前不能声称“统计上超过 90% 候选人”，因为没有全部候选作品和统一盲测数据。可验证的代理证据是：

- 30 个 Vitest 单测、4 个 Chromium E2E、TypeScript、ESLint、生产构建和 GitHub CI；
- 真实账号登录、匿名项目迁移、D1 持久化、固定发布版本和公开链接；
- 模型空回复、503、超时、401、Token/调用预算、取消、浏览器断流都有明确策略；
- 每次生成可以审计耗时、Token、模型、修复次数、事件和终态。

按题目“完整度、工程思维、用户体验、创新性、可交付性”五项，本项目具备前 10% 竞争力的工程代理特征，但最终排名仍由评审和同批候选作品决定。

## 下一阶段最高价值路线

1. **云端浏览器 QA**：为每个生成版本执行可配置的点击/表单/控制台检查并保存截图工件；
2. **生成应用持久化 API**：为白名单模板提供隔离的 KV/D1 数据层，而不是开放任意服务器代码；
3. **元素级修改**：在预览中选择 DOM 元素，把稳定 selector、截图和目标样式传给 Agent；
4. **Git 工件导出**：一键创建生成项目仓库、提交版本并开 PR；
5. **受控全栈模板**：先支持 Auth + CRUD + webhook 三类受控能力，再考虑任意依赖容器。

这条路线比“再加几个头像或多调用几次模型”更接近真正好用的产品上限。
