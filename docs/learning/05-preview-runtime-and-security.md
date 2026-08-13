# 05. 预览运行时与安全

## 1. “生成代码”和“Nucleus 自己的代码”是两套东西

Nucleus 自己是 React/Vinext 项目；模型生成的是无需构建的三个文件：

```text
index.html
styles.css
script.js
```

生成物没有写入服务器磁盘，也不会被 `eval` 在 Worker 中执行。它们以字符串存在 D1 和 React state 中，最后被组装进 iframe。

## 2. `composePreview()` 如何组装

`lib/runtime.ts` 做四步：

1. 取得 HTML；
2. 把 CSS 包成 `<style>`，插到 `</head>` 前；
3. 注入 Nucleus runtime bridge；
4. 把 JS 包成 `<script>`，插到 `</body>` 前。

结果作为 iframe 的 `srcDoc`：

```tsx
<iframe
  sandbox="allow-scripts allow-forms allow-modals allow-popups"
  srcDoc={srcDoc}
/>
```

`srcDoc` 适合小型生成物，因为不需要先上传静态文件再拿 URL。

## 3. 为什么转义 `</script>` 和 `</style>`

如果生成的 JavaScript 字符串里意外出现 `</script>`，浏览器 HTML 解析器会提前结束外层脚本标签，即使这段文字原本只是 JS 字符串。

组装前替换为 `<\/script`，可以防止外层 HTML 解析被提前截断。CSS 的 `</style>` 同理。

这不是完整 HTML sanitization，而是解决模板嵌入时一个明确的解析边界。

## 4. iframe sandbox 权限

当前允许：

- `allow-scripts`：生成 JavaScript 可以运行；
- `allow-forms`：表单可提交；
- `allow-modals`：允许 `alert` 等演示交互；
- `allow-popups`：允许打开新页面。

刻意没有 `allow-same-origin`。因此生成页面获得一个不透明 origin，不能被当成 Nucleus 主站同源页面，也不能读取主页面 Cookie、DOM 或存储。

如果同时给不受信任页面 `allow-scripts` 和 `allow-same-origin`，隔离价值会明显降低。不要为了修一个 storage 报错就随手加上。

## 5. localStorage 为什么报错

不透明 origin 下，浏览器可能拒绝访问 `localStorage`。但模型很常生成“记住主题”“保存任务”的代码，因此完全不处理会导致大量 Demo 失败。

runtime 先探测真实 `localStorage`：

- 可用：保持浏览器实现；
- 抛错：在当前 iframe 页面内注入一个内存对象，模拟 `getItem/setItem/removeItem/clear/key/length`。

这个 shim 只在本次 iframe 生命周期有效。页面重新装载后数据消失，这是有意识的安全与功能折中。

## 6. 启动成功与运行错误桥

runtime 监听两类错误：

- `window.error`：同步运行错误和资源错误；
- `unhandledrejection`：未捕获的 Promise rejection。

再发送：

```js
parent.postMessage({
  source: "nucleus-preview",
  type: "error",
  message: "..."
}, "*");
```

父页面同时检查消息来源窗口和 `source` 标识。这里发送端使用 `*` 是因为 sandbox iframe 是不透明 origin，无法写常规目标 origin；接收端验证因此更加关键。

runtime 还在 `DOMContentLoaded` 后发送：

```js
parent.postMessage({
  source: "nucleus-preview",
  type: "ready"
}, "*");
```

只有没有先捕获到运行错误时才发送 ready。工作台因此能区分“静态质量门通过”和“浏览器实际启动通过”。刷新按钮通过改变 preview key 真正重建 iframe，而不是只转一个图标。

## 7. 为什么不能直接在 React 页面插入生成 HTML

如果使用 `dangerouslySetInnerHTML` 把生成内容插进主页面：

- CSS 会污染工作台；
- 脚本可操作主页面 DOM；
- 可能读取主站可访问的数据；
- 页面错误会破坏整个 React 应用；
- 清理和刷新困难。

iframe 提供独立文档、样式空间、错误边界和生命周期，是本项目最重要的安全设计之一。

## 8. 当前 sandbox 仍然不等于绝对安全

即使没有同源权限，生成脚本仍可能：

- 向外部网站发送请求；
- 打开弹窗；
- 展示欺骗性表单；
- 消耗 CPU；
- 生成令人不适或侵权内容。

面向公众的大规模版本还应增加：

- 严格 Content Security Policy；
- 允许请求域名白名单或网络代理；
- iframe 超时/重建；
- 内容审核与举报；
- 下载文件扫描；
- 更细粒度的生成应用用户身份和数据权限（Nucleus 平台本身已有账号所有权）；
- 预览与主应用使用不同域名。

## 9. 与 WebContainer/容器方案的区别

| 方案 | 能力 | 风险与成本 | 本项目选择 |
|---|---|---|---|
| `srcDoc` iframe | HTML/CSS/JS | 低成本、范围有限 | 使用 |
| WebContainer | npm、构建工具、Node 风格环境 | 浏览器资源重、兼容复杂 | 未使用 |
| 服务端容器 | 几乎任意技术栈 | 隔离、资源、排队和供应链风险高 | 未使用 |
| 静态文件发布 | 稳定公开 URL | 需上传和清理产物 | 公开页仍用 D1 + iframe |

对笔试来说，明确限制能力比开启任意代码执行却没有安全措施更专业。

## 10. 可以继续做的运行时增强

推荐顺序：

1. 给 iframe 增加 CSP 与允许域名网络策略；
2. 捕获 console 日志并显示；
3. 用云端浏览器对生成物执行可配置点击/表单冒烟；
4. 保存截图、控制台和网络为版本 QA 工件；
5. 增加 CPU/运行超时与自动重建；
6. 最后再考虑多文件/npm/容器。

`ready`、真实刷新、运行错误回传和“一键让 Ray 修复”已经完成。当前最大缺口不是再加一个状态灯，而是对每个生成版本自动执行真实业务动作。
