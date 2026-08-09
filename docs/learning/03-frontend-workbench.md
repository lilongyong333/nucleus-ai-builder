# 03. 前端与工作台

## 1. 页面结构

项目有三类页面：

- `/`：落地页，输入需求、查看示例和最近项目；
- `/account`：登录账号的项目、版本、对话统计、工作台链接和成品链接；
- `/w/[id]`：工作台，生成、预览、看代码、迭代和恢复版本；
- `/p/[slug]`：公开预览页，只展示已发布应用。

方括号表示动态路由。例如 `/w/123` 中的 `123` 会作为 `id` 参数传入页面。

## 2. 首页创建项目

`app/page.tsx` 是客户端组件，因为它需要输入框状态、按钮点击和页面跳转。

核心流程可以简化为：

```ts
const response = await fetch("/api/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: clean }),
});

const data = await response.json();
router.push(`/w/${data.project.id}`);
```

注意：这里还没有开始调用模型，只是先把用户需求保存为一个 `draft` 项目，再跳转到工作台。

## 3. 为什么进入工作台才自动生成

`components/workbench.tsx` 加载项目后检查：

```ts
if (value.status === "draft" && value.versions.length === 0 && !startedRef.current) {
  startedRef.current = true;
  void runGenerate(value.prompt);
}
```

这样做有三个好处：

- 工作台先出现，用户能看到进度；
- 刷新已有版本时不会重复扣费生成；
- `startedRef` 防止 React 开发模式或依赖变化造成同页重复启动。

特别注意：如果服务端返回 `generating`，页面只进入恢复/轮询，不会自动再次 POST。这个判断由断流 E2E 明确保护。

## 4. 工作台有哪些状态

| 状态 | 类型 | 用途 |
|---|---|---|
| `project` | `Project \| null` | 当前项目和所有版本 |
| `generating` | `boolean` | 标记当前浏览器请求并显示加载态 |
| `activePrompt` | `string \| null` | 服务端消息回写前的即时用户消息 |
| `queuedPrompts` | `QueuedPrompt[]` | 当前生成期间排队的后续要求 |
| `queuePaused` | `boolean` | 用户停止后阻止队列自动续跑 |
| `timeline` | `TimelineItem[]` | Agent 工作事件 |
| `liveStream` | `LiveStreamState \| null` | 当前模型真实分片、字符数和阶段 |
| `livePlan` | `AgentPlan \| null` | 尚未保存时先展示计划 |
| `activeTab` | `preview/code` | 预览与代码切换 |
| `activeFile` | 三个文件之一 | 代码面板当前文件 |
| `device` | `desktop/mobile` | 预览宽度切换 |
| `previewError` | `string` | iframe 运行错误 |
| `previewState` | `checking/passed/error` | 沙箱启动校验状态 |
| `liveQuality` | `AppQualityReport` | Ray 当前轮质量结果 |
| `consoleEntries` | `ConsoleEntry[]` | iframe 转发的真实运行日志 |
| `showConsole` | `boolean` | 运行控制台开关 |
| `showVersions` | `boolean` | 版本抽屉开关 |
| `showMemory` | `boolean` | 最近项目对话抽屉 |

React state 的核心思想是：数据改变后，组件重新计算要显示的界面。不要手动寻找 DOM 去替换文本。

## 5. NDJSON 流怎么在浏览器解析

服务端返回的内容类似：

```text
{"type":"status","agent":"Iris",...}
{"type":"progress","agent":"Alex","delta":"<main",...}
{"type":"plan","plan":{...}}
{"type":"file","path":"index.html","size":4200}
{"type":"review","report":{"score":100,"grade":"A",...}}
{"type":"complete","project":{...}}
```

网络分块不保证一块刚好是一行，所以不能对每个 `reader.read()` 结果直接 `JSON.parse`。正确做法是维护 `buffer`：

1. 将新字节解码并追加到 `buffer`；
2. 按换行切分；
3. 最后一段可能不完整，留回 `buffer`；
4. 只解析已经完整的行；
5. 流结束后再处理最后一段。

代码在 `workbench.tsx` 的 `runGenerate()` 中。这个细节很重要，否则线上网络一分包就会随机出现 JSON 解析错误。

## 6. 事件如何变成界面

`handleEvent()` 是一个小型状态机：

- `status`：在时间线加入或替换某个 Agent 的工作状态；
- `progress`：拼接模型 SSE 内容尾部、累计真实字符数，并同时更新对话与右侧浮层；
- `plan`：即时显示产品计划；
- `file`：显示某文件已写入；
- `review`：即时显示 Ray 分数与 9 项检查；
- `complete`：用服务端返回的完整项目替换本地项目，包括 Run/Event/Message；
- `error`：抛出错误，统一进入 `catch`。

服务端才决定事实，前端只负责展示。比如版本号使用 `complete.project.versions[0]`，而不是前端自己加一。

## 7. 继续修改为什么能保留旧功能

用户在左侧输入新需求后，前端仍然只发送：

```json
{ "projectId": "...", "prompt": "增加深色模式" }
```

当前文件不由浏览器上传。服务端用 `projectId` 从 D1 读取可信的当前快照，再把文件作为上下文交给模型。优点是请求更小，也避免浏览器伪造项目内容成为数据真源。

## 8. 预览与代码视图

`useMemo()` 在项目文件变化时才重新组装 `srcDoc`：

```ts
const srcDoc = useMemo(
  () => project ? composePreview(project.files) : "",
  [project],
);
```

预览页把它传给 iframe；代码页把三个原始文件显示在 `<pre><code>` 中。桌面/手机切换只改变 iframe 容器宽度，不会生成第二份代码。

## 9. 恢复、发布、下载

- 恢复：POST `versionId`，服务端把该快照写回项目当前文件；
- 发布：服务端把 `published_version_id` 指向当前 Version，生成或复用 slug，前端复制 `/p/{slug}`；
- 下载：浏览器动态加载 JSZip，把三文件和说明写入 ZIP。

JSZip 使用动态 `import()`，因为只有点击下载时才需要，减少首页初始 JavaScript。

## 10. iframe 错误如何显示到工作台

工作台监听浏览器 `message` 事件，并同时验证：

- 消息来源必须是当前 iframe 的 `contentWindow`；
- `event.data.source` 必须是 `nucleus-preview`。

收到 `ready` 后显示“启动校验通过”；收到运行错误后显示错误条，用户可以把错误文字作为新 Prompt 交给 Ray 修复。

## 11. 浏览器流断开后如何恢复

`runGenerate()` 的 `catch` 不会马上把所有网络错误都判成生成失败：

1. GET 当前项目；
2. 如果项目已经 `ready`，直接同步完成版本；
3. 如果仍是 `generating`，显示“连接恢复中”；
4. 每约 1.8 秒读取一次服务端状态；
5. `ready/error/draft` 后停止轮询并同步终态；
6. 轮询期间保留“取消生成”；
7. 页面卸载时清理 timer。

这解决“浏览器连接断了，但服务端仍可能完成”的状态分歧。恢复逻辑不能凭本地 loading 状态猜结果，必须读 D1 中的项目和 GenerationRun。

## 12. 登录与对话记忆怎样进入前端

首页先 GET `/api/projects`，响应同时包含当前 `account`。未登录显示“登录保存”，登录后显示账号项目中心入口。

账号页由服务端身份解析后渲染，`account-dashboard.tsx` 展示：

- 项目状态和更新时间；
- 版本数、运行数、消息数；
- 完整 `/w/<id>` 工作台 URL；
- 已发布时的 `/p/<slug>` URL；
- 复制和打开按钮。

工作台项目详情最多读取最近 100 条消息；对话记忆抽屉只是展示 D1 消息，不是浏览器 localStorage。

## 13. 对话工作区、队列、语音和控制台

### 消息怎样和 Agent 步骤排在一起

`project.messages` 是服务端持久化的事实。前端另外维护一个 `activePrompt`，让用户点击发送后不必等 D1 再读一次就能立刻看到自己的消息。`complete.project` 到达后包含正式 Message，前端清掉 optimistic activePrompt，避免重复。

最近一轮 Run 的 `prompt` 会匹配最近一条相同内容的 user Message。`AgentActivityPanel` 被插入在这条消息之后、assistant 总结之前，因此读起来是：

```text
用户要求
  -> Iris / Bob / Alex / Ray 已处理步骤
  -> 真实模型分片与字符数
  -> 计划 / Ray 分数 / 运行审计
  -> Alex 的交付总结
```

刷新页面时本地 `timeline` 可能为空，此时用 `timelineFromProject(project)` 从最近 Run 的 D1 Events 重建，历史证据不会因为 React state 丢失。

### 为什么队列在前端，互斥仍在服务端

同一个项目不能并发生成，否则两个结果会争抢当前版本。用户在生成中按 Return 时，前端把 `{id, content, createdAt}` 放入 `queuedPrompts`。当前请求和服务端状态都结束后，effect 才取下一条调用 `runGenerate()`。

这只是好用的交互层。正确性仍由 D1 `generation_id` 租约保证；即使两个浏览器同时操作，第二个请求也会收到 409。点击停止后 `queuePaused=true`，不会偷偷启动下一条。

### Return、Shift+Return 与中文输入法

`onKeyDown` 只有同时满足以下条件才发送：

- `event.key === "Enter"`；
- 没有按 Shift；
- `event.nativeEvent.isComposing === false`。

最后一条很重要。中文输入法选字时也会触发 Enter；忽略 composing 会把半截拼音误发送。

### 语音输入怎样降级

浏览器存在 `SpeechRecognition` 或 `webkitSpeechRecognition` 时，点击麦克风会启动一次 `zh-CN` 识别并把最终 transcript 追加到文本框。结束、错误和组件卸载都会停止并释放对象。不支持该 API 时只显示提示，不影响键盘输入。

### 运行控制台不是装饰

`composePreview()` 在沙箱里包装 `console.log/info/warn/error`，通过已经存在的 `nucleus-preview` 消息桥转发。单次 iframe 最多转发 200 条，避免生成应用用高频日志拖垮主界面；工作台验证 `event.source === iframe.contentWindow` 后，只保留最近 100 条到 `consoleEntries`。同一控制台还显示 ready、window error 和 unhandledrejection，清空和关闭按钮都是真的。

## 14. 初学者修改前端的安全顺序

1. 只改文案，运行页面；
2. 只改 `app/globals.css` 中一个颜色；
3. 新增一个不访问后端的 UI 开关；
4. 给现有 API 增加一个字段；
5. 最后才改流解析、断流状态机或 `project` 数据结构。

每次只改一类问题，运行 `pnpm lint` 和 `pnpm exec tsc --noEmit`，确认通过再提交。
