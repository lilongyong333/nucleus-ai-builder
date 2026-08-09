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
├─ /api/generate：Planner → Builder → 持久化，NDJSON 推流
├─ /api/projects/:id/restore：恢复版本
└─ /api/projects/:id/publish：生成公开 slug

External
├─ OpenCode Go：规划与代码生成
└─ D1：Project / Message / Version / GenerationRun / AgentEvent
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
- 浏览器取消会中止原请求并把 AbortSignal 传给模型 fetch；独立取消 API 撤销租约。即使云平台未及时终止上游 I/O，旧任务也无法写入版本；
- 租约超过 10 分钟可回收，覆盖 Worker 异常退出和客户端断开；
- `published_version_id` 与 `current_version_id` 分离：工作区可继续迭代，公开链接只有再次发布时才更新。

系统不自行保存密码；游客路径保证评审打开即用，ChatGPT 登录提供跨设备账号路径。公开页只读取固定发布版本，不暴露 owner、对话和审计。

## 数据模型

- `projects`：游客或账号所有者、标题、当前文件、当前/已发布版本、生成租约和公开 slug；
- `messages`：用户和智能体摘要，保留迭代语义；
- `versions`：每轮完整三文件快照、模型和说明。
- `generation_runs`：每轮生成的提示词、状态、模型、起止时间、Token、模型调用/修复次数、关联版本和失败原因；
- `agent_events`：Iris、Bob、Alex、Ray 每个阶段的有序事件、状态、耗时、模型和阶段用量。

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
| 模型 | GLM-5.2 代码主模型 + Qwen 3.5 Plus 备用 | 全模型竞速 | 生产复杂生成中 GLM 延迟更适合边缘长连接，Qwen 保留故障降级 |

## 长任务和模型可靠性

- Iris 规划使用本地确定性 SOP；每轮构建、补文件和 Ray 修复共享 8 次调用、50,000 Tokens、240 秒总预算；
- 单次请求 55 秒超时；空回复最多重试一次，5xx/网络/超时可切换备用模型，401/429 不掩盖；
- 用户取消传播到所有模型 fetch；最终使用的模型链写入 GenerationRun 和 Version；
- NDJSON 每 8 秒写入透明心跳。浏览器断流后读取服务端状态并轮询，完成时自动同步版本；重新打开 `generating` 项目不会重复提交；
- 工作台状态明确区分草稿、生成中、生成失败和已保存，服务端遗留任务始终保留取消入口。

## 可观测的 Agent 叙事

- Iris：把自然语言变成产品名称、目标、功能和视觉方向；
- Bob：确认三文件结构和实现边界；
- Alex：生成或增量修改实际代码；
- Ray：执行确定性质量门、定向修复、建立版本，并接收运行错误用于修复。

四个名字映射到真实系统阶段，不是单纯用延时动画伪造的流程。
