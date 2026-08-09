# Nucleus 架构与设计取舍

## 产品目标

交付一条评审人无需注册即可验证的主路径：

```text
输入需求 → 看到 Agent 分工 → 得到可点击应用 → 继续修改 → 回滚版本 → 分享或下载
```

重点不是复刻 Atoms 的所有商业能力，而是复刻其核心体验：AI 不是聊天机器人，而是一支可观察、可持续协作的产品团队。

## 系统结构

```text
Browser
├─ Landing：创建项目、示例和最近项目
├─ Workbench：Agent 时间线、Preview / Code、版本和发布
└─ sandbox iframe：执行生成的 HTML / CSS / JavaScript

Cloudflare Worker
├─ /api/projects：项目创建和读取
├─ /api/runs：显式创建可恢复 GenerationRun
├─ /api/runs/:id/step：一次执行一个 Agent/文件阶段，NDJSON 推流
├─ /api/generate：旧单请求兼容接口
├─ /api/projects/:id/restore：恢复版本
└─ /api/projects/:id/publish：生成公开 slug

External
├─ OpenCode Go：Iris / Bob / Alex / Ray 的真实模型调用
└─ D1：Project / Message / Version / Run / Event / Artifact / ModelAttempt
```

## 为什么模型输出不用大 JSON

第一次真实验收发现：模型把 19KB 代码塞进 JSON 时，因为换行、引号或输出截断产生 `Unterminated string`。最终协议改为：

````text
<summary>本轮说明</summary>
```html{path=index.html}
...
```
````

解析器独立提取三个文件。继续修改时，模型允许只返回变化文件，解析器与当前快照合并。这个协议比大 JSON 更适合长代码，也与成熟开源生成器的实践一致。

## 预览安全边界

- 只支持 HTML / CSS / JavaScript，不执行服务器代码；
- iframe 使用 `sandbox="allow-scripts allow-forms allow-modals allow-popups"`；
- 不开启 `allow-same-origin`，生成代码无法读取父页面数据；
- 捕获同步错误和 Promise rejection；
- 转义生成脚本中的 `</script>`，避免提前闭合标签；
- 为 opaque origin 注入内存 storage，兼容常见生成代码。

## 工作区身份、所有权与状态一致性

- 首次访问由服务端签发 32 位随机 HttpOnly Cookie；浏览器脚本无法读取，SameSite=Lax 降低跨站请求风险；
- 登录使用 Sites 托管的 Sign in with ChatGPT。Worker 读取平台注入的受信身份头，以 `chatgpt:<userId>` 建立稳定 owner；
- 第一次登录会把当前 visitor owner 的项目迁移到账户 owner，对话、版本和公开链接因此可以跨设备读取；
- `owner_id` 约束项目列表、读取、生成、恢复和发布，未授权访问统一返回 404，避免泄露资源是否存在；
- `generation_id` 是同项目单写者租约。完成、失败和取消只能更新持有相同 generation ID 的任务，防止过期请求覆盖新结果；
- `active_step` 是 Run 内的阶段租约。浏览器重连、双击和多个标签不会重复执行同一阶段；
- 浏览器取消会中止原请求并把 AbortSignal 传给模型 fetch；独立取消 API 撤销租约。即使云平台未及时终止上游 I/O，旧任务也无法写入版本；
- 每个阶段都会刷新项目租约；连续 30 分钟没有阶段进展才回收，覆盖 Worker 异常退出且不误杀正常多阶段 Run；
- `published_version_id` 与 `current_version_id` 分离：工作区可继续迭代，公开链接只有再次发布时才更新。

系统不自行保存密码；游客路径保证评审打开即用，ChatGPT 登录提供跨设备账号路径。公开页只读取固定发布版本，不暴露 owner、对话和审计。

## 数据模型

- `projects`：游客或账号所有者、标题、当前文件、当前/已发布版本、生成租约和公开 slug；
- `messages`：用户和智能体摘要，保留迭代语义；
- `versions`：每轮完整三文件快照、模型和说明。
- `generation_runs`：每轮生成的提示词、状态、模型、起止时间、Token、模型调用/修复次数、关联版本和失败原因；
- `agent_events`：Iris、Bob、Alex、Ray 每个阶段的有序事件、状态、耗时、模型和阶段用量。
- `generation_artifacts`：需求、架构、三文件和质量工件；同一 Run/kind 唯一，可作为恢复检查点；
- `model_attempts`：每次主/备模型调用的状态、耗时、首字、字符数、HTTP 状态、usage 与错误。

工作台只读取最近 10 次运行和最多 200 条事件；项目列表和公开页面不携带审计数据，避免无关查询与私有执行信息泄露。`(run_id, sequence)` 唯一索引保证同一运行的事件顺序不重复。取消或过期后，新的事件插入和版本保存都会验证运行仍为 `running`，因此迟到响应不能污染已经终止的运行。

版本采用全量快照而不是 diff。单个演示应用通常只有几十 KB，全量快照的恢复逻辑更简单、更可靠，也更容易在面试中解释。

## 关键取舍

| 决策 | 选择 | 放弃 | 原因 |
|---|---|---|---|
| 运行环境 | 浏览器 iframe | Docker / WebContainer | 低冷启动、低成本、风险边界清晰 |
| 生成范围 | 三文件前端应用 | 任意全栈应用 | 保证在线 Demo 稳定 |
| 数据 | D1 云端持久化 | localStorage 作为真源 | 可跨会话、可发布共享 |
| 版本 | 全量快照 | 行级 diff | 小数据下恢复可靠性优先 |
| 认证 | HttpOnly 游客工作区 + Sign in with ChatGPT | 自建密码系统 | 打开即用，登录后跨设备保存，避免自行处理密码 |
| 模型 | Luna 负责需求/架构/审查，GLM 负责代码；彼此备用 | 一个模型包办所有角色、全模型竞速 | 结构化 JSON 与长代码协议的最佳模型不同；生产失败证据驱动按角色路由 |

## 长任务和模型可靠性

- Iris 和 Bob 都产生真实模型工件；Alex 把 HTML/CSS/JS 拆为三个阶段；Ray 独立审查并最多两轮定向修复；
- Run 硬预算为 24 次调用/180,000 Tokens；每个阶段最多 2 次调用/40,000 Tokens/52 秒；规划/审查主模型 26 秒，代码主模型 34 秒，均保留备用窗口；
- 空回复直接给备用模型机会，5xx/网络/超时可切换，401/429 和预算耗尽不掩盖；
- 用户取消传播到所有模型 fetch；最终使用的模型链写入 GenerationRun 和 Version；
- NDJSON 每 8 秒写入透明心跳。每个阶段完成后 Artifact/Attempt/Event 落盘并推进 `current_stage`；浏览器断流后重新调用同一 Run 的 step，从未完成阶段继续；
- 工作台状态明确区分草稿、生成中、生成失败和已保存，服务端遗留任务始终保留取消入口。

## 可观测的 Agent 叙事

- Iris：把自然语言变成需求、验收标准、风险和测试计划；
- Bob：建立信息架构、状态模型、交互流、文件职责和测试架构；
- Alex：按文件生成或迭代实际代码，每个文件立即形成检查点；
- Ray：结合确定性门、应用类型门和模型代码审查，定向修复，最终建立版本。

四个名字映射到真实系统阶段，不是单纯用延时动画伪造的流程。
