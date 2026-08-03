# Atoms Demo —— 开发计划

> 配套文档：[DESIGN.md](./DESIGN.md)
> 时间盒：**8 小时核心开发 + 1 小时文档收尾**（48 小时内提交）

---

## 0. 排期总览

| 阶段 | 时长 | 产出 | 风险等级 |
|---|---|---|---|
| P0 骨架与部署管道 | 0:00–0:40 | 空壳应用已在线，DB 已连通 | 低 |
| **P1 预览运行时** | **0:40–2:10** | **硬编码文件树能在 iframe 里跑起来** | **🔴 最高** |
| P2 Agent 编排 + 流式 | 2:10–4:00 | 一句话 → 多文件生成 → 落库 | 🟠 高 |
| P3 认证与项目持久化 | 4:00–4:50 | 登录、项目列表、刷新不丢 | 低 |
| P4 工作台 UI 打磨 | 4:50–6:00 | 三栏布局、时间线、打字机 | 中 |
| P5 衍生能力 | 6:00–7:10 | 自愈 + 检查点 + 发布 | 中 |
| P6 联调与兜底 | 7:10–7:50 | Bug 清扫、Demo 数据预置 | 中 |
| P7 交付物 | 7:50–9:00 | README、说明文档、录屏 | 低 |

### 排期的两条铁律

1. **P1 必须最先做，且必须用硬编码文件树跑通后再接 LLM。**
   如果先接 LLM 再调运行时，出问题时你分不清是模型生成得烂还是运行时有 bug，
   会在两个未知数之间反复横跳，这是最容易吞掉 3 小时的陷阱。

2. **P0 阶段就要把空壳部署到 Vercel。**
   部署问题（环境变量、构建失败、Node 版本、Edge/Node runtime 差异）如果留到最后一小时暴露，
   就没有修复窗口了。先把管道打通，之后每完成一个阶段推一次。

---

## P0 — 骨架与部署管道（0:00–0:40）

| # | 任务 | 完成标准 (DoD) |
|---|---|---|
| 0.1 | `npx create-next-app@latest` + TypeScript + Tailwind + App Router | `pnpm dev` 起得来 |
| 0.2 | `npx shadcn@latest init`，装 button / input / dialog / dropdown-menu / tabs / scroll-area / skeleton | 组件能渲染 |
| 0.3 | Vercel 建项目，关联 GitHub 仓库（**Public**） | push 后自动部署成功，有公网 URL |
| 0.4 | Vercel Marketplace 开通 Neon，环境变量自动注入 | `DATABASE_URL` 已存在 |
| 0.5 | Drizzle schema 落地（照抄 DESIGN.md §5），`drizzle-kit push` | Neon 控制台能看到 5 张表 |
| 0.6 | 建 `/api/health` 返回 DB 当前时间 | 线上访问返回真实时间戳 |

```bash
pnpm add drizzle-orm @neondatabase/serverless @anthropic-ai/sdk zustand nanoid
pnpm add -D drizzle-kit
```

**环境变量清单**（Vercel 与 `.env.local` 都要配）：

```
DATABASE_URL=            # Neon 自动注入
ANTHROPIC_API_KEY=       # 服务端专用，绝不加 NEXT_PUBLIC_ 前缀
AUTH_SECRET=             # openssl rand -base64 32
AUTH_GITHUB_ID=
AUTH_GITHUB_SECRET=
NEXT_PUBLIC_APP_URL=     # https://xxx.vercel.app
```

---

## P1 — 预览运行时（0:40–2:10）🔴 最高风险

**这 90 分钟是整个项目的成败点。全程不碰 LLM。**

| # | 任务 | 完成标准 (DoD) |
|---|---|---|
| 1.1 | 写 `lib/runtime/shell.ts`，导出 runtime HTML 字符串（照抄 DESIGN.md §4.2） | 字符串能生成 |
| 1.2 | 写 `components/Preview.tsx`：iframe + `srcDoc` + `sandbox="allow-scripts allow-forms allow-popups"` | iframe 出现在页面上 |
| 1.3 | 造一个**硬编码的三文件示例**（`/App.tsx` 引入 `/components/Counter.tsx` 引入 `/lib/utils.ts`） | 文件常量准备好 |
| 1.4 | postMessage 挂载，验证跨文件相对路径 import 正常 | **iframe 里出现一个能点的计数器** |
| 1.5 | 验证第三方包：让示例 import `lucide-react` 的图标 | 图标正确显示，无 "Invalid hook call" |
| 1.6 | 验证 Tailwind class 生效 | 样式正确 |
| 1.7 | 注入内存版 `localStorage` polyfill（sandbox 下原生的会抛异常） | 示例里调用 `localStorage.setItem` 不报错 |
| 1.8 | 接错误上报：`window.onerror` + `unhandledrejection` → postMessage | 故意写个 `undefined.foo`，父页面能收到错误对象 |
| 1.9 | 验证热重挂：修改文件内容后重新 mount，状态干净 | 无内存泄漏、无重复渲染 |

### 卡住时的决策点（**2:10 硬性检查**）

如果到 2:10 还没跑通 1.4，**立即执行降级**：

- 改为「单文件模式」：只支持一个 `/App.tsx`，Babel 转译后直接 `new Function` 执行
- 把这个决定记进说明文档的"关键取舍"一节（诚实的降级说明比假装完美更加分）
- 省下的时间投入 P4（UI）和 P5（衍生能力）

---

## P2 — Agent 编排与流式（2:10–4:00）🟠 高风险

| # | 任务 | 完成标准 (DoD) |
|---|---|---|
| 2.1 | 写 `lib/agent/prompt.ts` 系统提示（见下方模板） | 常量就绪 |
| 2.2 | 写 `lib/agent/tools.ts`（`set_plan` / `write_file` / `edit_file` / `finish`） | 类型正确 |
| 2.3 | 写 `/api/agent/run` Route Handler，SSE 流式返回 | curl 能看到事件流 |
| 2.4 | 实现 `applyTool()`：写文件到 `versions` 草稿 + 推送事件 | DB 里能看到文件内容 |
| 2.5 | 前端 `useAgentStream()` hook 消费 SSE，写入 Zustand | 控制台能打印出事件序列 |
| 2.6 | 把虚拟 FS 接到 P1 的 Preview 组件（300ms 防抖） | **端到端：输一句话 → 应用跑起来** |
| 2.7 | 多轮对话：追加消息时把历史带上 | "加个深色模式" 能正确增量修改 |

### 系统提示模板要点

```
你是 Alex，Nucleus 平台的资深前端工程师。你的产出会被直接放进浏览器运行时执行。

## 运行环境（硬约束，违反会导致白屏）
- React 18 函数组件 + TypeScript，JSX automatic runtime（不要 import React 就能写 JSX）
- 入口必须是 /App.tsx，且必须 `export default`
- 只能用这些依赖：react、react-dom、lucide-react、recharts、clsx、date-fns
  —— 不在名单里的一律自己实现，不要 import
- 样式只用 Tailwind CSS 原子类，不要写 .css 文件，不要用 CSS-in-JS
- 没有真实后端。需要持久化时用 React state；如需跨刷新，用 window.atoms.db（如果可用）
- 不要写 index.html、package.json、vite.config.ts 等构建产物

## 工作流程
1. 先调用一次 set_plan，规划产品要点和文件树（3–8 个文件）
2. 然后逐个调用 write_file 写代码。每个文件都要完整、可运行，不要留 TODO 或占位符
3. 全部写完后调用 finish

## 质量要求
- 界面要有设计感：留白、层次、微交互，不要用默认的紫色渐变 AI 味配色
- 必须有初始演示数据，用户打开就能看到内容，而不是空状态
- 移动端可用（flex/grid + 相对单位）
```

> 最后两条尤其重要 —— 空状态的应用在演示中毫无说服力，而"AI 味配色"会让评审一眼看出是未经调教的默认输出。

---

## P3 — 认证与持久化（4:00–4:50）

| # | 任务 | DoD |
|---|---|---|
| 3.1 | Auth.js v5 配置，GitHub OAuth provider | 能登录并拿到 session |
| 3.2 | **游客一键体验**：Credentials provider 创建匿名用户 | 点击即进入，无需填表 |
| 3.3 | `/dashboard` 项目列表（Server Component 直查 DB） | 卡片正确渲染 |
| 3.4 | 项目 CRUD Server Actions | 新建 / 重命名 / 删除可用 |
| 3.5 | 工作台加载历史：消息 + 最新版本文件 | **刷新页面后一切还在** |
| 3.6 | 游客速率限制（内存 Map 或 Neon 计数，IP 维度 3 次/小时） | 超限有友好提示 |

> 游客体验不是可选项。评审人打开链接如果第一屏是注册表单，
> 有相当概率直接关掉。"一键体验"能显著提升实际被完整体验的概率。

---

## P4 — 工作台 UI（4:50–6:00）

| # | 任务 | DoD |
|---|---|---|
| 4.1 | 三栏布局 + 可拖拽分隔条 | 布局稳定不抖 |
| 4.2 | Agent 时间线组件：头像、名字、状态点、展开/收起 | 视觉上像"团队在工作" |
| 4.3 | 计划卡片（`set_plan` 的结构化渲染） | 功能列表 + 文件树清晰 |
| 4.4 | 文件树 + Shiki 只读代码高亮 | 点击文件能看代码 |
| 4.5 | 打字机效果（消费 `file_delta`） | 代码逐字出现，有节奏感 |
| 4.6 | 预览工具栏：刷新、新窗口打开、移动端/桌面端切换 | 都能用 |
| 4.7 | 落地页：大输入框 + 4 个示例卡片 | 点击示例直接开跑 |

**示例卡片建议**（选对 Prompt 直接决定演示效果）：
- 「一个带番茄钟的极简待办应用」— 展示状态管理 + 定时器
- 「个人财务看板，带月度支出图表」— 展示 recharts 图表能力
- 「团队 Kanban 看板，支持拖拽」— 展示复杂交互
- 「一个小型打字速度测试游戏」— 展示趣味性与动画

---

## P5 — 衍生能力（6:00–7:10）

按优先级做，做不完就砍后面的。

| 优先级 | 功能 | 预估 | DoD |
|---|---|---|---|
| **P0** | 自愈闭环 | 40min | 故意报错能自动修好，UI 展示修复过程，上限 2 次 |
| **P0** | 版本检查点 + 回滚 | 20min | 下拉切版本，预览同步变化 |
| **P0** | 发布 `/p/[slug]` | 15min | 无痕浏览器能打开，全屏无平台 UI |
| P1 | 导出 ZIP（JSZip，含 package.json / vite.config） | 15min | 解压后 `pnpm i && pnpm dev` 能跑 |
| P1 | Race Mode 双模型竞速 | 45min | 左右两个预览，显示耗时/成本，可选择采用 |
| P2 | Atoms Cloud KV（`window.atoms.db`） | 45min | 生成的应用刷新后数据还在 |
| P2 | 版本 diff 视图 | 20min | 行级对比可读 |

---

## P6 — 联调与兜底（7:10–7:50）

| # | 任务 |
|---|---|
| 6.1 | 用 4 个示例 Prompt 各跑一遍完整链路，记录失败点 |
| 6.2 | 修 P1 级 bug（白屏、报错、流中断） |
| 6.3 | 加载态：骨架屏、生成中的进度提示、空状态文案 |
| 6.4 | 错误边界：Agent 失败 / 网络断开 / 超时 都有可读提示与重试按钮 |
| 6.5 | **预置 2–3 个已生成好的 Demo 项目**，游客登录即可直接查看 |
| 6.6 | 移动端过一遍（评审可能用手机打开） |
| 6.7 | 检查 client bundle 里没有 API key（`next build` 后 grep 一遍） |

> 6.5 极其重要：如果评审打开时 API 额度耗尽或网络抖动，
> 预置项目能保证他至少看得到成品。**这是可交付性的保险栓。**

---

## P7 — 交付物（7:50–9:00）

| # | 产出 | 要点 |
|---|---|---|
| 7.1 | `README.md` | 项目简介 / 截图 / 技术栈 / 本地启动 / 环境变量 / 架构图 |
| 7.2 | 笔试说明文档 | 见下方结构 |
| 7.3 | 60 秒演示录屏 | 一句话 → 生成 → 预览 → 迭代 → 自愈 → 发布，一镜到底 |
| 7.4 | 仓库设为 Public，清理敏感信息 | `git log` 里也不能有 key |
| 7.5 | 附 AI coding 工具账单截图 | 题目明确说是加分项 |

### 说明文档结构（对应题目要求）

```markdown
# Nucleus —— Atoms Demo 说明

## 1. 我理解的题目
（一句话说清你认为这道题在考什么）

## 2. 实现思路
- 产品：三栏工作台 + 多智能体时间线，复刻 Atoms 的"团队在为你工作"的核心体验
- 技术：一句话说清"浏览器内编译"这个核心决策

## 3. 关键取舍（重点写这节）
| 决策 | 我选了什么 | 放弃了什么 | 为什么 |
|---|---|---|---|
| 代码执行环境 | 浏览器内 Babel + esm.sh | Docker/E2B 真沙箱、WebContainer | 8h 窗口下，前者能覆盖 95% 场景且零基建；后者的容器编排与冷启动优化本身就是数天的工作 |
| 生成物范围 | 纯前端 React SPA | 全栈应用生成 | 后端生成需要部署编排，是一个数量级更大的问题 |
| 版本存储 | 全量 JSONB 快照 | 增量 diff | 单项目 < 100KB，全量换来回滚只需一行代码 |
| 代码编辑器 | 只读高亮 | 可编辑 Monaco | 用户来这里是为了不写代码；可编辑是伪需求 |

## 4. 当前完成度
✅ 已完成：（逐条列）
🚧 部分完成：（诚实标注局限，例如"复杂多文件项目偶发依赖解析失败，已有单文件降级"）
❌ 未做：（列出并说明为什么这是有意识的选择，不是遗漏）

## 5. 如果继续投入，我会怎么做
| 优先级 | 事项 | 理由 |
|---|---|---|
| P0 | 接入真沙箱（E2B），支持全栈生成 | 当前最大的能力天花板 |
| P0 | 选中元素 → 自然语言修改（Babel 插件注入 source 定位） | 最高频的迭代场景，比重新描述整页高效一个量级 |
| P1 | Agent 记忆：把项目约定沉淀成长期上下文 | 多轮迭代后风格会漂移 |
| P1 | 生成结果自动截图 + 视觉回归 | 让自愈闭环也能覆盖"没报错但长歪了" |
| P2 | GitHub 同步、自定义域名、模板市场 | 商业化必需，但非能力验证的关键路径 |

## 6. 在线体验
- 线上地址：https://xxx（点"游客体验"即可，无需注册）
- 源码：https://github.com/xxx
- 演示视频：https://xxx
- 预置示例项目：/p/aaa、/p/bbb

## 7. AI 工具使用
（账单截图 + 简述你怎么用 AI 完成这个项目 —— 这本身就是 AI Native 的证明）
```

---

## 附录 A：目录结构

```
nucleus/
├─ app/
│  ├─ page.tsx                      # 落地页
│  ├─ login/page.tsx
│  ├─ dashboard/page.tsx
│  ├─ w/[projectId]/page.tsx        # 工作台
│  ├─ p/[slug]/page.tsx             # 公开发布页
│  └─ api/
│     ├─ agent/run/route.ts         # 主生成流（SSE）
│     ├─ agent/heal/route.ts        # 自愈
│     ├─ apps/[id]/kv/route.ts      # Atoms Cloud 模拟
│     └─ auth/[...nextauth]/route.ts
├─ components/
│  ├─ workbench/{Timeline,Preview,CodePanel,FileTree,VersionMenu}.tsx
│  └─ ui/                           # shadcn
├─ lib/
│  ├─ agent/{prompt,tools,loop,events}.ts
│  ├─ runtime/{shell,polyfill}.ts   # iframe 运行时
│  ├─ store/vfs.ts                  # Zustand 虚拟文件系统
│  └─ db/{schema,client}.ts
└─ docs/{DESIGN.md,DEV-PLAN.md}
```

## 附录 B：常见故障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| iframe 白屏，控制台无报错 | 入口文件没有 `export default` | 提示词里强调；`mount` 时校验并给出可读错误 |
| `Invalid hook call` | 加载了两份 React | 所有第三方包必须 `?external=react,react-dom` |
| `localStorage is not available` | sandbox 无 `allow-same-origin` | 注入内存 polyfill |
| SSE 中途断开 | Vercel 函数超时 | `maxDuration=300`；每个文件即时落库；提供"继续生成" |
| 400 `temperature` 不被支持 | `claude-opus-5` 不接受采样参数 | 删掉 `temperature`/`top_p`/`top_k`，用提示词控制 |
| 响应被截断 | `max_tokens` 太小（思考 + 输出共用额度） | 流式下设到 64000 |
| 缓存命中率为 0 | 系统提示里插了每次都变的内容 | 动态上下文一律移到 `messages` |
| 生成的代码 import 了不存在的包 | 提示词没约束依赖 | 白名单 + `write_file` 时静态校验裸包 import |
