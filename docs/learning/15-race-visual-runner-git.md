# 15. Race Mode、可视化编辑、云端 Runner 与 Git 分支

这一章解释四项最接近 Lovable、Bolt、Replit Agent、Atoms 成熟体验的能力，以及它们在 Nucleus 中如何形成同一条可审计链路。

## 1. Race Mode：并行生成，不是重复调用取最长文本

普通模式中，Alex 对每个文件按主模型 → 备用模型的顺序执行。Race Mode 中，`activeCodeModels()` 返回可用代码模型，平台并行调用它们，然后按文件类型评分。

```mermaid
flowchart LR
  P["同一份 Iris/Bob 上下文"] --> A["模型 A 生成候选"]
  P --> B["模型 B 生成候选"]
  A --> S["确定性评分"]
  B --> S
  S --> W["选择最高分候选"]
  W --> R["Ray 全局质量门"]
  A --> D["race_candidates 审计"]
  B --> D
```

HTML 评分关注语义 `main`、viewport、交互控件、稳定选择器、可访问名称和三文件分离；CSS 关注响应式、焦点、减少动画、CSS 变量；JavaScript 关注真实事件、错误处理、渲染函数以及 `window.nucleus.data`。

评分只是候选预选，不替代 Ray。最终文件仍要通过解析、协议门、确定性质量门和 Ray 审查。

为什么不直接把 Token 上限无限提高：

- Cloudflare 单请求仍有时间窗；
- 长输出不等于正确输出；
- 超长上下文会提高成本和截断概率；
- 分阶段检查点、并行候选和自动恢复比单次豪赌更可靠。

当前整轮硬上限仍由环境变量控制，默认配置可达到 60 次模型调用和 500K Tokens；Race Mode 在这个预算内把更多额度用在独立候选上。

## 2. DOM 选中与局部可视化修改

预览 iframe 注入 Element Picker：

1. 工作台发送 `{ source: "nucleus-host", type: "picker" }`；
2. iframe 捕获 hover，绘制不拦截鼠标的高亮层；
3. 点击后生成稳定 selector、文本、属性、尺寸和计算样式；
4. iframe 把 `element-selected` 消息发回宿主；
5. 用户可以先发送 `visual-patch` 即时预览；
6. 点击“写入新版本”后，结构化 selector/样式要求进入正式多 Agent Run；
7. Alex 只修改目标相关代码，Ray 再做完整回归，成功后才形成新 Version。

即时 Patch 只用于确认意图，不会冒充已保存代码。刷新预览后，只有经过生成与 Ray 质量门的修改才会保留。

## 3. Console 和截图如何自动回灌 Ray

iframe 会捕获：

- `console.log/info/warn/error`；
- `window.error`；
- `unhandledrejection`；
- 标题、标题层级、可操作控件和部分 DOM；
- 当前 viewport。

事件一方面通过 `postMessage` 实时出现在工作台 Console，另一方面批量写入 `/events`，成为 `runtime_evidence`。同一版本首次出现致命错误时，工作台会把错误和 DOM 证据组织成修复请求交给 Ray；每版本最多自动触发一次，防止无限修复循环。

云端 Playwright Runner 的结果还可以包含：

- 点击了哪些控件；
- Console error；
- page error；
- 失败的网络请求；
- viewport；
- JPEG 截图 Data URL；
- 通过/失败总结。

失败证据通过带 Token 的 Callback 写入 D1，并由 `/runtime-repair/claim` 原子领取，避免一个错误被多个浏览器重复回灌。

## 4. 云端 Playwright Runner

仓库包含 `.github/workflows/generated-app-eval.yml` 和 `scripts/cloud-eval.mjs`。完整流程：

```text
工作台点击“运行 Playwright”
  → POST /api/projects/:id/runner-jobs
  → 检查应用已经公开发布
  → 创建 runner_jobs
  → GitHub workflow_dispatch
  → 安装 Chromium
  → 访问真实公开 URL
  → 查找并点击安全控件
  → 收集 Console / page / network / screenshot
  → POST /api/runner/callback
  → 写入 Job + runtime_evidence
  → 失败时 Ray 自动领取修复证据
```

未发布应用不会被发送给 Runner，因为外部云端浏览器无法访问私有工作台 iframe；接口会返回 409，提示先发布。

必要生产 Secret：

```dotenv
GITHUB_AUTOMATION_TOKEN=
GITHUB_RUNNER_REPOSITORY=owner/repository
GITHUB_RUNNER_REF=main
NUCLEUS_RUNNER_CALLBACK_TOKEN=
```

GitHub Actions 仓库还需要配置与生产环境相同的 `NUCLEUS_RUNNER_CALLBACK_TOKEN` Secret。

## 5. npm、pip、系统依赖与容器 Runner

Cloudflare Worker 不能也不应该直接运行不受信任的 Docker。Nucleus 实现的是外部 Runner Provider 协议：

```text
POST NUCLEUS_CONTAINER_RUNNER_URL
Authorization: Bearer NUCLEUS_CONTAINER_RUNNER_TOKEN

{
  jobId,
  projectId,
  versionId,
  files,
  dependencies: { npm, pip, system, containers },
  functions,
  callback: { url, bearerToken },
  limits: {
    cpuSeconds: 120,
    memoryMb: 1024,
    diskMb: 2048,
    network: "egress-filtered"
  }
}
```

Provider 应在短生命周期沙箱中完成依赖安装、构建、测试和启动探测，然后回调 `passed` 或 `failed`。推荐使用 Firecracker、gVisor、Kubernetes Job、Modal、E2B 或自建隔离执行集群；不能把宿主 Docker Socket 直接暴露给模型代码。

必要生产 Secret：

```dotenv
NUCLEUS_CONTAINER_RUNNER_URL=https://runner.example.com/jobs
NUCLEUS_CONTAINER_RUNNER_TOKEN=
NUCLEUS_RUNNER_CALLBACK_TOKEN=
```

当前仓库提供平台端协议、权限、状态、回调、审计与 UI；不附带一套托管的容器集群。因此未配置 Provider 时状态为 `configuration-required`。

## 6. 每 Agent Git 分支与自动合并

`lib/github-automation.ts` 使用 GitHub Git Data API，不在 Worker 本地运行 `git`：

1. 读取默认分支 HEAD 和 tree；
2. Iris 分支写需求工件；
3. Bob 分支以上一分支 commit 为父提交，写架构与 Manifest；
4. Alex 分支写三个生成文件；
5. Ray 分支写质量报告；
6. 最终把 Ray 分支合并到默认分支；
7. 每个分支名、commit SHA 和最终合并 SHA 写入 `git_integrations.last_sync_json`。

这种链式父提交保证四个 Agent 的工件不会彼此丢失，也使 Git 历史和 Nucleus Run 审计能相互对应。

环境变量：

```dotenv
GITHUB_AUTOMATION_TOKEN=
```

Token 应只授予目标仓库所需的 Contents 写权限。若默认分支受保护，合并请求可能被拒绝；平台会保留错误，不会绕开仓库策略。

## 7. 真正上线时的 Provider 验收

- 故意填错 GitHub Token，确认状态变为失败而非通过；
- 让 workflow 访问一个 404 URL，确认 Callback 写入错误和截图；
- 让容器构建安装不存在的包，确认 Job 失败且日志有限长；
- 重放同一个 Callback，确认已结束 Job 不会破坏其他项目；
- 用 viewer 角色尝试创建 Runner Job，确认返回 403；
- 用 protected branch 测试 Git 同步，确认遵守仓库保护；
- Race Mode 至少固定跑一组相同提示词，保存候选得分与最终 Ray 结果。

## 8. 与成熟产品仍有的差距

- 没有内置托管容器集群和多区域调度；
- 没有 GitHub App/OAuth 安装流程，目前依赖服务端 Token；
- DOM 编辑目前支持文字、颜色、背景、圆角，尚不是完整 Figma 式布局面板；
- Race 候选使用启发式评分，尚未建立大规模线上胜率模型；
- 云端浏览器是通用安全点击，不理解所有业务流程；
- 没有按用户输入自动生成专用 Playwright 测试文件的完整测试 Agent。

这些是下一阶段可度量的产品工作，不应在演示时声称已经与 Lovable 或 Replit Agent 等价。
