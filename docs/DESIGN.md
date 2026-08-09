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
└─ D1：Project / Message / Version
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

## 工作区所有权与状态一致性

- 首次访问由服务端签发 32 位随机 HttpOnly Cookie；浏览器脚本无法读取，SameSite=Lax 降低跨站请求风险；
- `owner_id` 约束项目列表、读取、生成、恢复和发布，未授权访问统一返回 404，避免泄露资源是否存在；
- `generation_id` 是同项目单写者租约。完成、失败和取消只能更新持有相同 generation ID 的任务，防止过期请求覆盖新结果；
- 浏览器取消会中止原请求并把 AbortSignal 传给模型 fetch；独立取消 API 撤销租约。即使云平台未及时终止上游 I/O，旧任务也无法写入版本；
- 租约超过 10 分钟可回收，覆盖 Worker 异常退出和客户端断开；
- `published_version_id` 与 `current_version_id` 分离：工作区可继续迭代，公开链接只有再次发布时才更新。

这不是完整账号系统，但在“无需注册即可评审”的约束下提供了清晰的数据隔离边界，并可平滑升级为登录用户 ID。

## 数据模型

- `projects`：匿名所有者、标题、当前文件、当前/已发布版本、生成租约和公开 slug；
- `messages`：用户和智能体摘要，保留迭代语义；
- `versions`：每轮完整三文件快照、模型和说明。

版本采用全量快照而不是 diff。单个演示应用通常只有几十 KB，全量快照的恢复逻辑更简单、更可靠，也更容易在面试中解释。

## 关键取舍

| 决策 | 选择 | 放弃 | 原因 |
|---|---|---|---|
| 运行环境 | 浏览器 iframe | Docker / WebContainer | 低冷启动、低成本、风险边界清晰 |
| 生成范围 | 三文件前端应用 | 任意全栈应用 | 保证在线 Demo 稳定 |
| 数据 | D1 云端持久化 | localStorage 作为真源 | 可跨会话、可发布共享 |
| 版本 | 全量快照 | 行级 diff | 小数据下恢复可靠性优先 |
| 认证 | HttpOnly 匿名工作区 | OAuth | 评审打开即用，同时隔离不同访客数据 |
| 模型 | GLM-5.2 | 遍历调用全部模型 | 实测速度、可用性与代码质量更平衡 |

## 可观测的 Agent 叙事

- Iris：把自然语言变成产品名称、目标、功能和视觉方向；
- Bob：确认三文件结构和实现边界；
- Alex：生成或增量修改实际代码；
- Ray：执行确定性质量门、定向修复、建立版本，并接收运行错误用于修复。

四个名字映射到真实系统阶段，不是单纯用延时动画伪造的流程。
