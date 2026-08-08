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

## 数据模型

- `projects`：标题、最近需求、当前文件、当前版本、公开 slug；
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
| 认证 | 游客模式 | OAuth | 评审打开即用 |
| 模型 | GLM-5.2 | 遍历调用全部模型 | 实测速度、可用性与代码质量更平衡 |

## 可观测的 Agent 叙事

- Iris：把自然语言变成产品名称、目标、功能和视觉方向；
- Bob：确认三文件结构和实现边界；
- Alex：生成或增量修改实际代码；
- Ray：校验文件、建立版本，并接收运行错误用于修复。

四个名字映射到真实系统阶段，不是单纯用延时动画伪造的流程。
