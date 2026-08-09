# 04. AI 生成链路

## 1. API Key 在哪里使用

模型调用只发生在 `lib/opencode.ts`，它从 Cloudflare Worker 的运行时环境读取：

- `OPENCODE_GO_API_KEY`；
- `OPENCODE_GO_BASE_URL`；
- `OPENCODE_GO_MODEL`、`OPENCODE_GO_FALLBACK_MODEL`；
- 单次超时，以及整轮调用/Token/时间预算。

浏览器永远拿不到真实 Key。变量不能使用 `NEXT_PUBLIC_` 前缀，因为该前缀表示允许打进客户端代码。

OpenCode Go 提供多种接口协议。本项目默认模型 `glm-5.2` 使用 OpenAI-compatible 的 `chat/completions`：

```text
POST https://opencode.ai/zen/go/v1/chat/completions
Authorization: Bearer <server-side-secret>
Content-Type: application/json
```

请求主体的关键字段是：

```json
{
  "model": "glm-5.2",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "max_tokens": 8000,
  "stream": false
}
```

这里模型到 Nucleus 服务端不是流式的；Nucleus 服务端自己把阶段状态包装成 NDJSON 流给浏览器。

## 2. 为什么 Iris 现在不再调用模型

早期版本用 Planner 和 Builder 两次模型调用。真实生产基准发现，结构化规划占 20 多秒，而应用名、摘要、功能列表和视觉方向可以用明确规则稳定提取。

当前 `lib/planner.ts` 的 `planFromPrompt()` 在本地生成：

```json
{
  "appName": "旅行预算助手",
  "summary": "帮助用户规划旅行预算",
  "features": ["新增预算项", "分类统计", "剩余预算"],
  "design": "清爽卡片式布局，移动端友好"
}
```

这一步仍然是可持久化、可审计的 Iris 工件，但指标是：

- 0 Token；
- 0 模型调用；
- 通常 0–1ms；
- 支持新建/继续迭代摘要；
- 功能最多 5 项；
- 根据关键词推导深色、霓虹、清新等视觉方向。

### Alex 唯一的正常创造性调用

输入原始需求、计划和可选的当前文件，输出一段摘要加三个带路径的代码块。

当前好处：

- 计划可以先显示，降低等待焦虑；
- Builder 不必同时决定产品范围和写代码；
- 结构化计划可以持久化，便于版本说明；
- 计划规则和代码模型可以分别测试；
- 正常生成只花一次模型往返；
- 边缘长连接超时风险和费用更低。

这不是把 Agent 变成假动画。Iris 仍写入 requirements AgentEvent；真正需要创造性的 Alex 才使用模型；Ray 主要用确定性代码检查，只有失败才调用一次修复模型。

## 3. 模型输出协议

Builder 必须按这个形式返回：

````text
<summary>完成旅行预算助手</summary>

```html{path=index.html}
...HTML...
```

```css{path=styles.css}
...CSS...
```

```js{path=script.js}
...JavaScript...
```
````

协议限制：

- 只能有这三个文件名；
- `index.html` 不内嵌 `<style>` 或 `<script>`；
- 不使用外部库；
- 主按钮必须有真实行为；
- 单文件限制大小；
- 不在生成文件内部再放 Markdown fence。

## 4. 为什么不用一个巨大的 JSON

早期尝试让模型返回：

```json
{
  "index.html": "...",
  "styles.css": "...",
  "script.js": "..."
}
```

代码里大量引号、换行、反斜杠和模板字符串都必须再次转义。输出越长，越容易出现 `Unterminated string`。路径代码块让代码保持原样，解析器只需要找到 fence 的路径与内容，稳定性更高。

## 5. 解析器怎么工作

`lib/parser.ts` 使用正则寻找 `path=...` 代码块，只接受白名单文件：

```ts
if (
  path === "index.html" ||
  path === "styles.css" ||
  path === "script.js"
) {
  files[path] = content;
}
```

白名单避免模型输出 `../../secret`、服务端文件或意外的几十个文件。

解析后调用 `normalizeGeneratedFiles()`，确保：

- 三个文件最终都存在；
- 内容不是空字符串；
- 单文件不超过 120,000 字符；
- 残留的外层 fence 被移除。

## 6. 增量修改怎么合并

第一次生成要求三文件完整。继续修改时，模型可能只返回变化文件，例如只返回 `styles.css`。解析器使用：

```ts
normalizeGeneratedFiles({
  ...currentFiles,
  ...newFiles,
});
```

新文件覆盖旧文件，未返回文件沿用当前版本。这是浅合并，但三文件映射正适合这种做法。

注意：当前实现相信模型能保证跨文件一致性。例如它只改 HTML、却忘记改 JS 时，仍可能产生运行错误；后续可以增加 DOM 静态检查或自动浏览器测试。

## 7. 模型网关、空返回与主备切换

`lib/model-gateway.ts` 集中处理所有外部模型调用。线上曾出现 HTTP 成功但 `message.content` 为空，当前策略是：

1. 第一次正常请求；
2. 如果内容为空，追加一条“立即输出最终产物”的用户消息再请求；
3. 如果某些推理模型把完整产物放在 `reasoning_content`，且其中含协议标记，则容错使用；
4. 仍无结果才抛错。

空回复只重试一次，随后可以进入备用模型。错误分类如下：

| 情况 | 是否 fallback | 原因 |
|---|---|---|
| 主模型成功 | 否 | 直接返回 |
| 网络错误、5xx、单次超时 | 是 | 供应商/模型可能暂时不可用 |
| 连续空回复 | 是 | 当前模型没有交付有效内容 |
| 401 | 否 | Key/权限错误，换模型通常无效 |
| 429 | 否 | 套餐/频率额度通常是整体限制 |
| 用户 AbortSignal | 否 | 用户明确取消，不能继续花费 |
| 调用/Token/总时长预算耗尽 | 否 | 整轮硬边界已触发 |

当前默认预算：单次 55 秒、最多 8 次模型请求、50,000 总 Tokens、240 秒整轮时长。构建、补文件和 Ray 修复共享同一个 `ModelBudget`，不是每个阶段重新拿一份额度。

## 8. 首次生成漏文件修复

第一次生成不能依赖旧文件。系统先用 `extractGeneratedFiles()` 检查三文件，若发现缺失：

1. 列出缺失文件名；
2. 把已生成文件和原需求作为上下文；
3. 发起一次定向 repair 请求；
4. 要求只返回缺失文件；
5. 将原回复和 repair 回复一起解析。

这种“检测具体缺陷，再定向补齐”的策略，比把整个大请求盲目重跑更省额度、更稳定。

## 9. 模型选择是怎么做的

我们没有把所有模型都完整跑一遍。正确流程是：

1. 查询 `/models` 了解当前可用列表；
2. 选代表性代码模型做小型可用性测试；
3. 再做一两个完整页面的延迟与完整度测试；
4. 根据质量、延迟、套餐权限和成本选默认值。

实测过程中：

- `qwen3.5-plus` 的结构化规划探针可用，但复杂三文件输出超过边缘长连接窗口；
- `glm-5.2` 在确定性 Iris 后完成复杂看板只用 21 秒、6,293 Tokens、1 次调用，因此成为代码主模型；
- `qwen3.5-plus` 保留为 5xx/网络/超时备用；
- `kimi-k2.7-code` 小请求可用，但完整生成曾超过 180 秒；
- 某些模型在当时套餐返回 403，因此不能只看模型列表就假设可用。

模型与套餐会变化，测试记录是当时证据，不是永久保证。模型 ID 留在环境变量中，切换时不必改代码。

## 10. Prompt 注入与现实边界

用户输入会进入模型上下文，不能把模型输出当可信代码。当前边界是：

- 输出只能落在三个虚拟文件；
- 不在 Worker 中执行生成代码；
- iframe 不授予同源权限；
- 文件大小受限；
- 不允许模型控制服务端 Prompt 或 API Key。

仍需注意：生成页面可以在浏览器中发起网络请求、弹窗或诱导用户输入。因此公开平台要增加内容政策、URL 过滤、CSP、举报和审计机制。

## 11. 如何自己调模型参数

### 换模型

只改环境变量并重新部署：

```dotenv
OPENCODE_GO_MODEL=另一个兼容-chat-completions-的模型ID
OPENCODE_GO_FALLBACK_MODEL=备用模型ID
```

不同模型可能使用 `responses` 或 `messages` 端点，不能只改 ID。先核对 OpenCode Go 官方端点表。

### 改输出长度

- Iris planner 不调用模型；
- Builder 为 8000；
- Repair 为 5000。

过小会截断文件，过大增加最坏成本和等待时间。还要同时考虑 `OPENCODE_GO_MAX_TOTAL_TOKENS` 与长连接窗口，应该基于真实应用集调整，不要凭感觉无限增大。

## 12. Ray 为什么主要是代码而不是另一个“评审模型”

`lib/quality.ts` 使用 Acorn 解析 JavaScript，并做 9 项确定性检查。确定性检查有三个优点：

- 同一文件得到同一结果；
- 毫秒级、零 Token；
- 可以写单元测试和明确失败原因。

只有质量门不通过时，才把结构化问题清单、原需求和文件交给 Ray 做最多一次定向修复，再重新运行全部检查。这样形成有预算上限的闭环，避免模型互相讨论却没有可验证结果。

## 13. 官方延伸阅读

- [OpenCode Go：模型、限额和端点](https://opencode.ai/docs/go/)
