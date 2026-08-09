# 03. 前端与工作台

## 1. 页面结构

项目有三类页面：

- `/`：落地页，输入需求、查看示例和最近项目；
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
if (value.versions.length === 0 && !startedRef.current) {
  startedRef.current = true;
  void runGenerate(value.prompt);
}
```

这样做有三个好处：

- 工作台先出现，用户能看到进度；
- 刷新已有版本时不会重复扣费生成；
- `startedRef` 防止 React 开发模式或依赖变化造成同页重复启动。

## 4. 工作台有哪些状态

| 状态 | 类型 | 用途 |
|---|---|---|
| `project` | `Project \| null` | 当前项目和所有版本 |
| `generating` | `boolean` | 禁用重复提交、显示加载态 |
| `timeline` | `TimelineItem[]` | Agent 工作事件 |
| `livePlan` | `AgentPlan \| null` | 尚未保存时先展示计划 |
| `activeTab` | `preview/code` | 预览与代码切换 |
| `activeFile` | 三个文件之一 | 代码面板当前文件 |
| `device` | `desktop/mobile` | 预览宽度切换 |
| `previewError` | `string` | iframe 运行错误 |
| `showVersions` | `boolean` | 版本抽屉开关 |

React state 的核心思想是：数据改变后，组件重新计算要显示的界面。不要手动寻找 DOM 去替换文本。

## 5. NDJSON 流怎么在浏览器解析

服务端返回的内容类似：

```text
{"type":"status","agent":"Iris",...}
{"type":"plan","plan":{...}}
{"type":"file","path":"index.html","size":4200}
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
- `plan`：即时显示产品计划；
- `file`：显示某文件已写入；
- `complete`：用服务端返回的完整项目替换本地项目；
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
- 发布：服务端生成或复用 slug，前端复制 `/p/{slug}`；
- 下载：浏览器动态加载 JSZip，把三文件和说明写入 ZIP。

JSZip 使用动态 `import()`，因为只有点击下载时才需要，减少首页初始 JavaScript。

## 10. iframe 错误如何显示到工作台

工作台监听浏览器 `message` 事件，并同时验证：

- 消息来源必须是当前 iframe 的 `contentWindow`；
- `event.data.source` 必须是 `nucleus-preview`。

收到运行错误后显示错误条，用户可以把错误文字作为新 Prompt 交给模型修复。

## 11. 初学者修改前端的安全顺序

1. 只改文案，运行页面；
2. 只改 `app/globals.css` 中一个颜色；
3. 新增一个不访问后端的 UI 开关；
4. 给现有 API 增加一个字段；
5. 最后才改流解析或 `project` 数据结构。

每次只改一类问题，运行 `pnpm lint` 和 `pnpm exec tsc --noEmit`，确认通过再提交。
