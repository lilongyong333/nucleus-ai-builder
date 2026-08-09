# 04. AI 生成链路

## 1. API Key 在哪里使用

模型调用只发生在 `lib/opencode.ts`，它从 Cloudflare Worker 的运行时环境读取：

- `OPENCODE_GO_API_KEY`；
- `OPENCODE_GO_BASE_URL`；
- `OPENCODE_GO_MODEL`。

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

## 2. 为什么分 Planner 和 Builder 两次调用

### 第一次：Iris 规划

输入用户需求，输出严格 JSON：

```json
{
  "appName": "旅行预算助手",
  "summary": "帮助用户规划旅行预算",
  "features": ["新增预算项", "分类统计", "剩余预算"],
  "design": "清爽卡片式布局，移动端友好"
}
```

这一步给 UI 提供结构化信息，也给下一次构建提供约束。

### 第二次：Alex 构建

输入原始需求、计划和可选的当前文件，输出一段摘要加三个带路径的代码块。

好处：

- 计划可以先显示，降低等待焦虑；
- Builder 不必同时决定产品范围和写代码；
- 结构化计划可以持久化，便于版本说明；
- 两个阶段可以分别调试。

代价是多一次请求。对于短周期 Demo，这是值得的；高并发生产系统可能把规划合并、缓存或改成更便宜的模型。

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

## 7. 空返回重试

线上曾出现 HTTP 成功但 `message.content` 为空。`chat()` 最多尝试两次：

1. 第一次正常请求；
2. 如果内容为空，追加一条“立即输出最终产物”的用户消息再请求；
3. 如果某些推理模型把完整产物放在 `reasoning_content`，且其中含协议标记，则容错使用；
4. 仍无结果才抛错。

只重试一次是为了控制延迟和额度。生产系统还应根据 429、5xx、网络超时分别采用指数退避和熔断。

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

- `glm-5.2` 完整生成通常约 25–60 秒，成为默认模型；
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
```

不同模型可能使用 `responses` 或 `messages` 端点，不能只改 ID。先核对 OpenCode Go 官方端点表。

### 改输出长度

- Planner 当前 `max_tokens` 为 900；
- Builder 为 8000；
- Repair 为 5000。

过小会截断文件，过大增加最坏成本和等待时间。应该基于实际生成文件分布调整，不要凭感觉无限增大。

## 12. 官方延伸阅读

- [OpenCode Go：模型、限额和端点](https://opencode.ai/docs/go/)
