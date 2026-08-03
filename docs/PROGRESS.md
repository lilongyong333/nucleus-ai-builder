# 开发进度记录

> 逐阶段记录：**做了什么 / 为什么这么做 / 怎么验证 / 踩了什么坑**。
> 用途：① 自己复盘学习 ② 需要时把某个阶段整段交给其他 AI 工具接手。

**任务编号规则**：`S<阶段>.<序号>`。完整任务清单见本文档末尾「阶段总览」。

---

## S0 工程基线

**目标**：拿到一个能构建、能部署、合规文件齐全的空壳，把部署问题提前暴露。

### S0.1 Next.js 脚手架 + 生产构建通过 ✅

**做了什么**

```bash
npx create-next-app@latest nucleus \
  --typescript --tailwind --eslint --app \
  --no-src-dir --import-alias "@/*" --use-pnpm --no-turbopack --yes
```

实际产出版本：**Next.js 16.2.12 / React 19.2.4 / Tailwind CSS 4.3.3 / TypeScript 6.0.3**。

> 注：设计文档里写的是 Next.js 15，脚手架实际给到 16。App Router 与 Route Handler 的用法一致，
> 不影响架构，后续文档以实际版本为准。

**为什么把项目建在 `demo/nucleus/` 而不是 `demo/`**

父目录 `demo/` 里放着笔试原题 PDF。**git 仓库根设在 `nucleus/`，PDF 从物理上就不可能进入版本控制**。
题目明确要求不得对外传播原题，这是最省事的隔离方式——比靠 `.gitignore` 记得写更可靠。

**踩坑 1：pnpm 11 中断安装**

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: sharp@0.34.5
Aborting installation.
```

pnpm 10+ 默认**禁止依赖执行构建脚本**（供应链安全策略），`sharp` 需要编译原生模块，于是安装中断。

修复：编辑 `pnpm-workspace.yaml`

```yaml
allowBuilds:
  sharp: true
  unrs-resolver: true
```

然后 `pnpm install` 正常完成。把审批固化进配置文件而不是跑交互式的 `pnpm approve-builds`，
是为了让 CI / Vercel 上的安装同样干净——**否则线上会重现同一个错误**。

**踩坑 2：TypeScript 版本选择**

脚手架给的是 TS 5.0.2，构建时 Next.js 警告「最低推荐 5.1.0」。

- 装 `typescript@latest` → 得到 **7.0.2** → 构建直接失败：
  `TypeScript 7.0.2 does not provide the compiler API required by Next.js`
- 按报错提示装 `typescript@6` → **6.0.3** → 构建通过，零警告

**教训：`@latest` 在大版本跨越期是陷阱。** Next.js 16 目前要求 TS 6.x —— 装完必须立刻跑一次
`pnpm build` 验证，不能只看安装成功。

**验证**

```bash
pnpm build
# ✓ Compiled successfully in 3.9s
# ✓ Generating static pages (4/4)
```

---

### S0.2 仓库合规文件 ✅

**做了什么**：新增 4 个文件。

| 文件 | 作用 |
|---|---|
| `.gitignore` | 在脚手架默认基础上追加：`/upstream/`（上游源码本地克隆，只读不入库）、`*.pdf`（防御性排除笔试原题）、`/private/`、运行期产物目录 |
| `LICENSE` | MIT，并在末尾指向 `THIRD_PARTY_NOTICES.md` |
| `THIRD_PARTY_NOTICES.md` | 第三方代码声明骨架，S1.1 填入 LlamaCoder 的 commit SHA 与许可证原文 |
| `.env.example` | 环境变量模板，注明「仅服务端读取，不得加 `NEXT_PUBLIC_` 前缀」 |

同时重写 `README.md`：项目定位、技术栈、本地启动、**开源复用与自研范围**章节。

**为什么现在就写 attribution 骨架，而不是最后补**

复用开源代码本身完全正当，**但事后补声明和事前声明，在面试里是两种性质**。
先把 `THIRD_PARTY_NOTICES.md` 的结构立起来，S1.1 移植代码时顺手填 SHA，
就不会出现「交付前才想起来要写」的窘境。README、LICENSE、NOTICES 三处口径一致。

**注意事项（已登记到最终自检任务）**

`docs/DESIGN.md` 的第 1 节含有对笔试原文要求的引述。**仓库转为 Public 之前需要改写为概括性描述**。
当前仓库为 Private，暂不受影响。

---

### S0.3 git init + 首次提交 🚧

见下一节记录。

---

## 环境信息（本机）

| 工具 | 版本 |
|---|---|
| Node | 24.15.0 |
| pnpm | 11.5.0 |
| git | 2.51.1.windows.1 |
| GitHub CLI | 2.97.0（通过 `winget install --id GitHub.cli -e` 安装） |

---

## 阶段总览

| 阶段 | 任务 | 状态 |
|---|---|---|
| **S0 工程基线** | S0.1 脚手架 + 构建 | ✅ |
| | S0.2 合规文件 | ✅ |
| | S0.3 git init + 首次提交 | 🚧 |
| | S0.4 创建 GitHub 仓库并推送 | ⏳ 待 `gh auth login` |
| | S0.5 Vercel 部署空壳上线 | ⏳ |
| **S1 运行时移植**（Gate 0） | S1.1 锁定 LlamaCoder 基线 commit | ⏳ |
| | S1.2 移植预览运行时模块 | ⏳ |
| | S1.3 硬编码多文件用例跑通预览 | ⏳ |
| | S1.4 运行时错误回传桥接 | ⏳ |
| | S1.5 iframe 截图能力注入 | ⏳ |
| **S2 数据层** | S2.1 Neon 开通 + 连通 | ⏳ |
| | S2.2 Drizzle schema 落地 | ⏳ |
| **S3 Agent 编排** | S3.1 Claude SDK 最小调通 | ⏳ |
| | S3.2 工具定义 | ⏳ |
| | S3.3 SSE 流式 Route Handler | ⏳ |
| | S3.4 前端事件消费 + 虚拟文件系统 | ⏳ |
| | S3.5 端到端打通 | ⏳ |
| **S4 视觉自愈** 🔥 | S4.1 截图送审 | ⏳ |
| | S4.2 修复闭环 + 复检 | ⏳ |
| | S4.3 过程 UI 可视化 | ⏳ |
| **S5 决策溯源** 🔥 | S5.1 元数据贯通 | ⏳ |
| | S5.2 决策卡片 UI | ⏳ |
| **S6 产品化** | S6.1 认证 + 游客入口 | ⏳ |
| | S6.2 版本快照 + 回滚 | ⏳ |
| | S6.3 公开发布页 | ⏳ |
| | S6.4 预置 Demo 项目 | ⏳ |
| **S7 交付** | S7.1 README + 架构图 | ⏳ |
| | S7.2 提交说明文档 | ⏳ |
| | S7.3 60 秒录屏 | ⏳ |
| | 转 Public + 最终自检 | ⏳ |

🔥 = 差异化能力，ROI 最高，不可裁剪。
