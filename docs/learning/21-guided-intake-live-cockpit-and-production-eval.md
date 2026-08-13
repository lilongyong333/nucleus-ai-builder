# 引导式需求、实时构建工作台与生产 Eval

> 本文记录 2026-08-13 的真实改造和验收。它回答四个问题：为什么首页进入工作台后不应再点一次“正式构建”；多 Agent 运行时右侧应该显示什么；为什么“无限 Token”仍不能保证成功；以及这次到底用真实模型生成并点击测试了哪些应用。

## 1. 这轮最终交付了什么

这一轮不是增加更多宣传卡片，而是把“提出想法 → 澄清方向 → 自动构建 → 实时观察 → 失败可解释 → 刷新仍有数据”打通：

1. 首页创建草稿后，Iris 立即调用真实模型分析需求并给出 **3 个互斥方向**，其中一个标记为推荐；
2. 用户选择方向后，选项会被展开成明确的产品、视觉、交互、边界和验收要求，并自动创建正式 Run；
3. 不再出现第二个“开始正式构建”按钮；用户的那次选择就是明确授权；
4. 左侧保留对话、Agent 阶段、工件、质量结果和失败原因；字号与信息密度提高；
5. 右侧不再重复一个黑色“生成中”框，而是展示 `index.html`、`styles.css`、`script.js` 的真实写入状态和当前代码尾部；
6. 1/3、2/3、3/3 文件写入后逐步刷新候选预览；没有完整三文件和 Ray 通过时不会伪装成 v1；
7. 失败原因直接显示在左侧 `role="alert"` 卡片中，同时保留完整 Run、ModelAttempt、Artifact 和 AgentEvent 审计；
8. 生成应用继续运行在不含 `allow-same-origin` 的严格 iframe 中，但通过受限宿主桥保存 `localStorage`，刷新预览和打开公开页后数据不会因为 opaque origin 丢失；
9. 代码模型首片等待、阶段上限和流关闭语义已按真实 GLM 延迟重新校准；即使阶段超时，也必须发出终态并关闭响应，页面不会永远显示“连接中”；
10. 打字测试、番茄钟、轻量看板、贪吃蛇四类首页任务均经过新的真实 Iris 选项和真实多 Agent 生成，不使用预制 Demo 冒充结果。

## 2. 用户流程为什么这样设计

旧流程的问题是：

```text
首页输入需求
  → 创建草稿并跳工作台
  → 页面只说“需求已保存”
  → 用户还要再点“开始正式构建”
```

从用户视角看，第一次点击已经表达了“我要做这个应用”。第二个按钮既重复，又让人误以为模型已经在工作。新流程改成：

```text
首页输入需求
  → 创建草稿
  → Iris 返回 3 个可选择方向
  → 用户选择其中一个
  → 扩展为完整 Prompt
  → 自动创建真实 GenerationRun
  → Iris → Bob → Alex HTML/CSS/JS → Ray → Version
```

这里仍然保留人工控制：系统不会在用户没有选方向时消耗大额代码 Token；一旦用户选中，系统就不再要求第二次确认。

### 对应代码

| 责任 | 主要位置 | 做什么 |
|---|---|---|
| 草稿和入口 | `app/page.tsx`、`components/landing-page.tsx` | 创建项目并进入工作台 |
| Iris 选项 API | `app/api/projects/[id]/intake/route.ts` | 调模型生成 3 个方向、解析、恢复并持久化 |
| Intake 数据 | `db/schema.ts`、`drizzle/0010_*.sql`、`lib/db.ts` | 保存 `intake_json` 和对话消息 |
| 选择后自动构建 | `components/workbench.tsx` | 合并原需求与选项详情，然后调用 `POST /api/runs` |
| 分阶段执行 | `app/api/runs/[id]/step/route.ts` | 每次推进一个可恢复阶段并返回 NDJSON |

## 3. 三个选项不是写死模板

`POST /api/projects/:id/intake` 会把原始需求交给 Iris，要求输出恰好三个方向。每个方向包含：

- 名称；
- 一句话定位；
- 为什么适合当前需求；
- 视觉和交互风格；
- 将被追加到正式构建 Prompt 的详细说明；
- 是否推荐。

服务端会检查数量、字段长度、重复项和推荐数量。模型输出不可解析时，系统会生成与原需求相关的保守方向并把恢复写进审计；它不会因此直接生成一套无关 Todo 模板。

幂等也很重要：刷新工作台不会重复调用模型或重复插入三组选项。项目已有 `intake_json` 时 API 直接返回已保存结果。

## 4. 右侧“老板视角”实时工作台

右侧的 `LiveBuildMonitor` 不重复左侧对话，而是回答三个更有价值的问题：

1. **现在是谁在做什么？** 显示当前 Agent、阶段和真实耗时；
2. **已经写出哪些文件？** 三个文件分别显示等待、写入中、已持久化和 KB 大小；
3. **模型真的在返回内容吗？** 显示当前文件的真实流式尾部、模型名称和累计字符数。

当完整文件落盘后，候选预览按 1/3、2/3、3/3 更新。预览上方会明确区分：

- `渐进预览 1/3`：只有 HTML；
- `渐进预览 2/3`：已有 HTML/CSS；
- `候选工件 · 待 Ray 审查`：三文件齐全，但还不是正式版本；
- `已保存版本启动通过`：Ray 通过并写入 Version 后才出现。

因此“看到页面”不等于“生成成功”，Version 才是正式完成语义。

## 5. 为什么不能把 Token 设置成无限

Token 是模型最多能读写多少内容，不是网络、边缘运行时间或协议完整性的保证。真实生产测试发现：

- GLM 代码请求的第一个可见 Token 有时超过 75 秒；
- 旧 `CODE_FIRST_TOKEN_TIMEOUT_MS=75000` 会在模型刚要开始输出时切换或终止；
- 阶段总上限到了以后，旧代码在 abort 状态下跳过终态和 `controller.close()`；
- 浏览器因此一直显示“连接中”，看起来像 Token 不够，实际是超时和流生命周期错误。

当前生产默认值调整为：

```dotenv
OPENCODE_GO_CODE_FIRST_TOKEN_TIMEOUT_MS=140000
OPENCODE_GO_CODE_REQUEST_TIMEOUT_MS=175000
OPENCODE_GO_CODE_FALLBACK_RESERVE_MS=70000
OPENCODE_GO_MAX_MODEL_CALLS=60
OPENCODE_GO_MAX_TOTAL_TOKENS=500000
OPENCODE_GO_STEP_MAX_CALLS=4
OPENCODE_GO_STEP_MAX_TOTAL_TOKENS=100000
OPENCODE_GO_STEP_MAX_DURATION_MS=280000
```

阶段路由的最终 deadline 为 285 秒。预算现在足够宽，但仍然有界，因为有界预算才能：

- 防止供应商死连接永久占用 Worker；
- 让取消、重试、计费和告警有明确语义；
- 保证单个坏 Prompt 不会无限消耗同一组织额度；
- 在失败时留下可审计的终态。

结论是：**可以把预算拉高，但不能把工程边界删除。**

## 6. 严格沙箱为什么会丢 `localStorage`

预览 iframe 刻意不包含 `allow-same-origin`：

```html
<iframe sandbox="allow-scripts allow-forms allow-modals allow-popups">
```

这样生成代码即使尝试读取宿主页面，也处在 opaque origin 中，不能与 `www.llynb.cc` 同源。代价是浏览器可能拒绝 iframe 的原生 `localStorage`。旧 runtime 只在内存里模拟，所以刷新后看板任务消失。

直接添加 `allow-same-origin` 虽然能让数据留下，但生成内容同时拥有 `allow-scripts` 时会扩大沙箱逃逸面，不是可接受修复。

### 当前桥接方案

`lib/runtime.ts` 在原生存储不可用时注入兼容 API：

```text
生成应用 localStorage.setItem
  → iframe 内存立即更新
  → postMessage({ source: "nucleus-preview", type: "storage", ... })
  → Workbench 校验 event.source 必须是当前 iframe
  → preview-storage.ts 校验 action/key/value/总配额
  → 宿主按 projectId 写入自己的 localStorage
  → 刷新时把可信快照重新注入 opaque iframe
```

限制为：

- 最多 200 个 key；
- key 最长 256 字符；
- 单值最多 50,000 字符；
- 每个应用总量最多 1,000,000 字符；
- 仅接受 `set/remove/clear`；
- 工作台与公开成品按同一 `projectId` 隔离并共享该浏览器中的应用数据；
- 不把宿主 Cookie、Token 或其他项目数据暴露给生成代码。

这解决的是浏览器本地数据。需要跨设备、多用户共享的数据仍应使用已经提供的 `window.nucleus` 每应用 API、Schema 和 Auth，而不是把 `localStorage` 说成云数据库。

## 7. 真实生产生成与点击验收

以下四个项目都从首页卡片重新创建，Iris 均返回了三组不同方向，选择后自动进入真实多 Agent 流水线。失败、重试和降级都保留，没有删除失败记录。

| 场景 | 工作台 | 真实生成结果 | 人工浏览器验收 |
|---|---|---|---|
| 中文打字速度 | <https://www.llynb.cc/w/3da4f379-b121-4c71-8a7f-be470b65e28e> | v1，Ray 100/A；首次 HTML 因把 CSS/JS 内联而被三文件协议拒绝，重试后通过 | 开始、随机题目、真实按键、进度 `10/40`、错误输入后正确率变化、重新开始归零、粘贴被阻止均通过 |
| 极简番茄钟 | <https://www.llynb.cc/w/a6007b2e-4115-41a9-a8c3-42cfaa947b13> | 第一轮失败；从保留审计的失败 Run 重试后生成 v1，Ray 100/A | 新增任务、启动 25 分钟、时间按时间戳下降、暂停、继续、结束确认、标记完成、今日完成 `0→1` 均通过 |
| 轻量项目看板 | <https://www.llynb.cc/w/d59ccb26-96f7-42a9-91f9-428e2b0073c6> | 第一轮未过质量门；重试后 v1，确定性 Ray 100/A；模型审查不可用的事实在 UI 中保留 | 新建任务后计数 `1/0/0`，两次点击流转为 `0/1/0`、`0/0/1`；旧版刷新丢数据暴露沙箱存储问题，并推动本轮持久化桥和 E2E |
| 贪吃蛇 | <https://www.llynb.cc/w/56732477-e886-448a-91f9-428e2b0073c6> | v1，Ray 100/A | 开始、暂停、继续、重新开始、方向控制、吃到食物后得分/最高分 `10`、撞墙 Game Over、移动端触控方向和最高分刷新保持均通过 |

额外的财务 CRUD 候选生成中，实际新增 `¥88.66` 后，总支出、余额、分类和最近交易均更新；人工检查发现 `.empty-state { display:flex }` 会覆盖 HTML `[hidden]`，因此新增 `finance-hidden-visibility` 阻断质量门。这个例子说明人工点击不是为了给已经成功的页面盖章，而是把真实缺陷回灌成可重复执行的确定性检查。

### 不夸大的部分

- 浏览器自动化接口不能可靠模拟中文输入法组合事件，所以打字应用的中文 IME 仍需要人工键盘复核；自动验收已覆盖真实按键、粘贴阻止、统计和重置；
- 四个场景是生产样本，不是足够大的随机盲测，不能据此宣称“任意 Prompt 100% 成功”；
- 看板和番茄钟都有首次失败，说明供应商输出仍有随机性；产品价值在于失败可见、工件保留、可重试和质量门不放水；
- 固定 283 项产品/安全 Eval 是契约覆盖，不等于 283 次付费模型生成；
- 宿主桥是浏览器本地持久化，不等于已经为每个应用创建物理数据库。

## 8. 自动化发布门

本轮最终本地门禁：

```text
Vitest                         18 files, 363/363
固定产品与安全 Eval            3 files, 283/283
专项 Sandbox 安全             17/17
Chromium Playwright E2E       11/11
TypeScript                    PASS
ESLint                        PASS
Vinext production build       PASS
git diff --check              PASS
```

新增回归重点是：

- Iris 恰好三选一，选择后自动构建；
- 右侧显示真实代码工作台，不再显示重复黑框；
- 失败 Run 原因不需要展开审计才能看到；
- 严格 opaque iframe 中写入 `localStorage`，点击工作台刷新后值仍存在；
- 存储消息超长、超键数、超总量时拒绝；
- 财务空状态不能被 CSS 意外强制显示；
- 阶段 abort 后仍写终态并关闭流。

## 9. 从零复现这轮行为

```powershell
cd C:\Users\Windows\Desktop\demo\nucleus
pnpm install
Copy-Item .env.example .env.local
pnpm dev
```

在 `.env.local` 填写新创建的模型密钥，不要使用曾经公开粘贴过的值。然后：

1. 打开首页；
2. 点击任一示例或输入自己的需求；
3. 确认 Iris 显示三组选项；
4. 选择一项，观察是否无需第二个按钮就开始；
5. 观察右侧三文件和真实代码字符增长；
6. 生成完成后实际点击核心功能；
7. 刷新预览并确认生成应用数据仍在；
8. 展开执行审计，核对模型、首字时间、Token、错误、修复和 Ray 结果；
9. 运行全部门禁：

```powershell
pnpm test
pnpm eval:product
pnpm test:security
pnpm lint
pnpm exec tsc --noEmit
pnpm build
pnpm test:e2e
git diff --check
```

## 10. 面试时可以怎么讲

可以直接这样回答：

> 我没有把多 Agent 做成四个头像轮流说话，而是把它做成有状态、有工件、有质量门的流水线。首页先由 Iris 生成三个产品方向，用户选择后自动进入正式 Run；Bob 只负责架构工件，Alex 分文件写真实代码，Ray 独立做确定性检查、模型审查和有限修复。每个阶段都写 D1 检查点和模型尝试，断线可以续跑，失败不会拿预制 Demo 冒充成功。右侧实时显示真实代码和三文件进度，左侧保留对话与审计。预览继续使用严格 opaque iframe；为了既不加 `allow-same-origin` 又能刷新保存任务，我实现了带来源校验和配额的宿主存储桥。最后我用打字、番茄钟、看板和贪吃蛇做了真实生产生成和点击验收，首次失败也保留并写进文档。

一句话总结：**这轮优化的重点不是让页面看起来更像 Atoms，而是让“先讨论、再生成、能观察、会失败、可恢复、能验收”成为真实产品行为。**
