# 17. P2/P3 部署与验收 Runbook

这是一份从干净机器把当前版本跑起来、配置可选 Provider、执行发布门并验证线上状态的操作清单。

## 1. 环境要求

- Windows 10/11、macOS 或 Linux；
- Node.js 22.13+；
- pnpm 11；
- Git；
- 需要推送 GitHub 时安装 GitHub CLI；
- 需要真实云端 Provider 时准备 GitHub Token、Runner Secret 和容器 Runner。

Windows PowerShell：

```powershell
Set-Location C:\Users\Windows\Desktop\demo\nucleus
pnpm install
Copy-Item .env.example .env.local
```

任何真实 Secret 都只写 `.env.local` 或托管平台 Secret，不写文档、不写源码、不提交 Git。

## 2. 最小环境变量

```dotenv
OPENCODE_GO_API_KEY=
OPENCODE_GO_BASE_URL=https://opencode.ai/zen/go/v1
OPENCODE_GO_MODEL=gpt-5.6-luna
OPENCODE_GO_FALLBACK_MODEL=glm-5.2
OPENCODE_GO_CODE_MODEL=glm-5.2
OPENCODE_GO_CODE_FALLBACK_MODEL=gpt-5.6-luna
OPENCODE_GO_MAX_MODEL_CALLS=24
OPENCODE_GO_MAX_TOTAL_TOKENS=180000
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

用户曾在聊天中公开粘贴过 API Key。公开过的 Key 必须在提供商控制台撤销并重新生成；仅把它从仓库删掉不能恢复安全性。

## 3. 可选 Provider 变量

```dotenv
# GitHub Agent branches and GitHub Actions dispatch
GITHUB_AUTOMATION_TOKEN=
GITHUB_RUNNER_REPOSITORY=owner/repository
GITHUB_RUNNER_REF=main

# Signed callback shared by Nucleus and runners
NUCLEUS_RUNNER_CALLBACK_TOKEN=

# External dependency/container execution
NUCLEUS_CONTAINER_RUNNER_URL=https://runner.example.com/jobs
NUCLEUS_CONTAINER_RUNNER_TOKEN=
```

如果不配置这些变量，核心生成、应用 API、数据、Auth、日志、备份、Race 和可视化编辑仍可运行；Git、云浏览器、容器卡片会显示 `configuration-required`。

## 4. 数据库迁移

Drizzle Schema：`db/schema.ts`。

本轮 migration：`drizzle/0007_robust_gravity.sql`。

生成新 migration：

```powershell
pnpm db:generate
```

运行时 `ensureSchema()` 仍保留兼容性初始化，用于旧 D1 平滑升级；正式生产应把 migration 当作可审计主路径，不能只依赖请求时 ALTER。

## 5. 本地质量门

```powershell
pnpm test
pnpm eval:fixed
pnpm test:e2e
pnpm exec tsc --noEmit
pnpm lint
pnpm build
git diff --check
```

本轮基线：

| 检查 | 结果 |
|---|---:|
| Vitest | 70/70 |
| 固定 Manifest Eval | 25/25 |
| Chromium E2E | 7/7 |
| TypeScript | 通过 |
| ESLint | 通过 |
| Vinext production build | 通过 |

25 个固定 Eval 只证明 Manifest 规范化和安全边界覆盖，不等于“生成任意应用的严格成功率”。要统计成功率，必须冻结更大的 Prompt 集、模型版本、评分规则、运行环境和人工验收标准。

## 6. 本地功能验收

1. `pnpm dev` 启动；
2. 新建项目，确认 v0 不冒充 Demo；
3. 点击正式构建，观察 Iris/Bob/Alex/Ray 流式阶段；
4. 在代码页确认三文件；
5. 打开“应用全栈资源”，查看 Manifest、Schema、Auth；
6. 在预览里用 Element Picker 选中元素并即时 Patch；
7. 写入新版本并确认 Ray 通过；
8. 开启 Race Mode 再生成一次，查看候选和得分；
9. 创建数据备份；
10. 开启审批并走提交/通过/发布；
11. 未配置 Provider 时确认显示 `configuration-required`，不能显示 passed。

## 7. GitHub Actions Runner 配置

仓库需要保留：

```text
.github/workflows/generated-app-eval.yml
scripts/cloud-eval.mjs
```

设置 Actions Secret：

```powershell
gh secret set NUCLEUS_RUNNER_CALLBACK_TOKEN --repo owner/repository
```

输入 Secret 时不要把值留在 PowerShell 历史或工具输出中。生产 Sites 环境使用同一个 Callback Secret。

工作流需要 `workflow_dispatch` 权限。服务端 Token 至少需要触发该工作流；Git 自动分支还需要目标仓库 Contents 写权限。

## 8. 容器 Runner 最低安全要求

Provider 必须做到：

- 每个 Job 独立临时目录或虚拟机；
- 非 root；
- CPU、内存、磁盘、进程数和时间限制；
- 默认阻断云元数据地址和内网；
- 出站域名或网络策略；
- 不挂载宿主 Docker Socket；
- 不把 Nucleus/GitHub/模型 Secret 注入生成容器；
- 日志和产物限长；
- Job 完成后销毁；
- Callback 使用 HTTPS 和一次性/轮换 Secret；
- 镜像、依赖和系统包做漏洞扫描。

## 9. 线上验收矩阵

| 能力 | 不配置外部 Provider | 配置后预期 |
|---|---|---|
| 应用 API/Schema/Auth | ready | ready |
| 数据 CRUD/日志/备份 | ready | ready |
| Race Mode | ready | ready |
| DOM 可视化修改 | ready | ready |
| 组织/RBAC/审批/用量 | ready | ready |
| Git Agent 分支 | configuration-required | connected/sync result |
| 云端 Playwright | configuration-required | queued → running → passed/failed |
| npm/pip/system/container | configuration-required | queued → running → passed/failed |

## 10. 回滚

代码发布回滚：在 Sites 项目中选择上一个已知健康 Version 重新部署。

生成应用代码回滚：工作台 → 版本 → 恢复指定 Version。

生成应用数据回滚：全栈资源 → 数据库备份 → 恢复；恢复前自动建检查点。

Git 回滚：遵循目标仓库的 PR/revert 流程，不让 Nucleus 越过 branch protection。

## 11. 仍未完成或不能夸大的部分

- 没有随仓库交付托管容器集群；
- 没有 GitHub App OAuth 安装界面；
- 没有邮件邀请；
- 没有真实支付扣费；
- 没有大规模固定生成成功率统计；
- 没有物理一应用一数据库；当前是严格项目命名空间；
- 没有完整 Sentry/OTel/APM、跨区域灾备和自动定时备份；
- 生成物仍以三文件浏览器应用为主，外部 Backend Function 需要 Runner/Provider 继续扩展。

这些边界不会影响当前面试作品展示“真实生成、持久化、可恢复、可审计、可协作”的核心价值，但在答辩中必须如实说明。
