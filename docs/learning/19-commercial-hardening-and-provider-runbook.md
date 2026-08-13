# 商业化加固与 Provider 落地 Runbook

> 更新日期：2026-08-12
> 适用代码：`agent/metagpt-quality-gate` 分支最新版本
> 目标：说明“代码已经做到什么、外部账号还要配置什么、故障后怎样恢复”，避免把 Provider 接口写成已经购买并上线的云资源。

## 1. 先看结论

这一轮把 Nucleus 从“有商业功能入口的 Demo”推进为“有可恢复控制面的早期产品底座”。最重要的变化不是多了几个按钮，而是所有异步外部动作都有了明确状态、审计记录、重试上限和失败语义。

已经在代码和本地发布门中验证的能力：

1. 每个正式生成版本自动登记独立物理 D1 目标，后台触发 Provisioner；
2. Provisioner 使用租约避免重复创建，能回收卡死任务、按指数退避重试并调和 Schema 漂移；
3. 物理 D1 创建后分页迁移旧数据，再回放一次并发期间的新 Revision；
4. D1 Time Travel 书签可回滚；绑定 `ARCHIVE` R2 后，还会导出 SQL/JSON 形成独立长期归档；
5. GitHub App Installation Token 成为默认凭据，旧 PAT 默认禁用；
6. Runner 回调同时验证 Bearer、原始 Body HMAC、五分钟时钟窗口和 Job 终态，重复回调被拒绝；
7. 邮件与告警改成 Outbox-first：先落库再调用 Resend/Sentry/Webhook，维护任务可以恢复失败投递；
8. Stripe Webhook 会同步订阅、发票与组织权益，取消、暂停、未支付时自动降级，而不是只改变界面文案；
9. 移动端可以通过触屏事件选择 iframe 内 DOM，修改文字、尺寸、间距、Display 和 Grid，并交给 Agent 写入新版本；
10. 固定产品 Eval 扩展到 240 个语义变体；当前发布门实际通过 363 个 Vitest、283 项产品/安全 Eval、17 项专项安全测试和 11 个 Playwright E2E；
11. 压测脚本支持多 Cookie 用户池、读写场景、期望状态、失败率和 P95 阈值；本轮实际运行 1,000 请求、40 并发、0 失败。

仍然不能声称已经完成的事情：

- 仓库没有附送一个已经付费、在线运行的 Kubernetes/gVisor/Kata 集群；它提供安全合同和 Provider 协议；
- 没有替用户注册 GitHub App、Stripe、Resend、Sentry 或开通 Cloudflare API Token；
- R2 是独立对象归档层，但没有完成第二云厂商跨区域灾备演练，不能宣传为完整跨云 DR；
- 240 个固定 Eval 是确定性产品契约，不等于 240 次真实付费模型生成；
- 1,000 请求压测验证的是 40 并发匿名客户端，不等于 1,000 个真实登录账号的生产容量结论；
- 安全规则是纵深防御，不代替专业红队、容器逃逸审计和供应链扫描平台。

## 2. 用大白话理解 Provisioner

Provisioner 就像“云资源管家”。生成应用只声明“我需要一个数据库和这些表”，管家负责把愿望变成真实资源，并在中途中断后继续做完。

```text
Ray 通过并保存 Version
  -> saveGeneration 写入 AppManifest
  -> app_database_resources 写入 desired_schema_version
  -> Worker waitUntil 异步触发 ensureProjectDatabase
  -> 创建独立 D1（如果还没有）
  -> 创建/增量修改集合表
  -> 分页迁移逻辑 D1 数据
  -> 回放并发窗口内更高 Revision
  -> 状态改为 ready
  -> 定时维护继续调和失败、卡死和 Schema 漂移
```

为什么不能只在生成请求里直接创建数据库？因为模型生成已经接近 Worker 时间窗口，云 API 还可能限流、超时或短暂失败。如果把两件事绑在同一个请求里，数据库失败会把已经通过质量门的代码也一起判死。现在采用“先提交声明，再异步调和”的做法，和 Kubernetes Controller 的思想相似。

### 2.1 状态机

| 状态 | 大白话解释 | 谁负责推进 |
|---|---|---|
| `pending` | 已登记，等待创建 | 后台任务/维护任务 |
| `provisioning` | 某个带租约的 Worker 正在操作 | 当前 Worker |
| `ready` | 真实 D1 与目标 Schema 一致 | 正常 Runtime API |
| `error` | 调用失败，保存了错误和下次重试时间 | 维护任务 |
| `configuration-required` | 缺少 Cloudflare 最小权限凭据 | 运维配置后维护任务 |
| `deletion-scheduled` | 进入数据保留期，还可以撤销 | 到期清理任务 |
| `deleted` | 外部数据库已经删除 | 终态 |

关键字段位于 `app_database_resources`：

- `schema_version`：外部数据库已应用的版本；
- `desired_schema_version`：当前 AppManifest 想要的版本；
- `attempt_count`：连续失败次数；
- `next_retry_at`：指数退避后允许再次尝试的时间；
- `lease_expires_at`：防止两个 Worker 同时创建/迁移；
- `retention_until`：删除前的数据保留截止时间；
- `last_error`：可展示、可审计的最近错误。

Schema Revision 只根据集合、访问策略、字段、类型、Required 和 Default 计算。只改按钮颜色不会无意义地迁移数据库；增加 `priority` 字段才会触发调和。

## 3. 数据库备份和恢复

### 3.1 两层备份

| 层 | 作用 | 限制 |
|---|---|---|
| D1 Time Travel Bookmark | 分钟级就地回滚，恢复速度快 | Cloudflare 套餐决定可用历史窗口 |
| R2 SQL/JSON Archive | 保存独立导出文件，支持超过 Time Travel 窗口的保留策略 | 需要 `ARCHIVE` R2 绑定；当前未做第二云厂商复制 |

物理 D1 备份流程：

1. 读取当前 Time Travel Bookmark；
2. 将 Bookmark 和记录数写入 `app_backups`；
3. 如果存在 `ARCHIVE`，调用 D1 Export API；
4. 持续使用 `at_bookmark` 轮询，拿到一小时有效的 HTTPS 下载地址；
5. 把 SQL Response Body 流式写入 `database-backups/<project>/<backup>.sql`；
6. 保存对象 Key、字节数和归档状态；
7. 归档失败不会抹掉可用的 Time Travel 恢复点，而是记录 `failed` 并触发告警。

过期清理先删除 R2 对象，再删除控制面元数据。如果归档桶未绑定或删除失败，会保留元数据而不是制造“数据库显示已删除，但对象还永久留存”的合规漏洞。

### 3.2 恢复的危险性

恢复会覆盖当前数据，所以代码先自动创建“恢复前备份”，再执行 Time Travel Restore。面试时可以这样说：

> 恢复是破坏性动作，因此系统先生成可撤销检查点，再恢复目标 Bookmark；并发查询可能被 Cloudflare 取消，所以生产上还要配维护窗口、审批和恢复演练。

## 4. GitHub App，而不是长期 PAT

默认凭据顺序现在是：

```text
项目绑定的 GitHub App Installation
  -> 服务端生成约 1 小时有效的 Installation Token
  -> 只访问用户选择并授权的仓库
  -> 到期后重新生成
```

旧 `GITHUB_AUTOMATION_TOKEN` 只有同时设置 `NUCLEUS_ALLOW_LEGACY_GITHUB_PAT=true` 才会启用。这样可以避免部署环境里残留的 PAT 静默覆盖 GitHub App。

需要在 GitHub 创建 App 并配置：

```dotenv
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY=
GITHUB_RUNNER_INSTALLATION_ID=
GITHUB_RUNNER_REPOSITORY=owner/repository
```

推荐权限：

- Repository contents：Read and write；
- Actions：Read and write（只有触发云端 Playwright 时需要）；
- Metadata：Read-only；
- 安装时只选择目标仓库，不选所有仓库。

## 5. Runner 与安全沙箱

Nucleus Worker 不直接运行模型生成的 shell、npm install 或 Docker。它生成一个 `SandboxContract`，交给外部 Runner 执行。

合同强制要求：

- gVisor 或 Kata 等强隔离 Runtime；
- 只读根文件系统；
- UID 65532 非 root；
- Drop all Linux capabilities；
- 禁止提权；
- 默认 Seccomp；
- 网络默认拒绝；
- CPU、内存、磁盘、PID 和执行时间上限；
- npm 只接受 Registry 包名并使用 ignore-scripts；
- pip 拒绝 URL、额外索引和命令参数；
- 容器镜像必须固定 `sha256` Digest 且 Registry 在 Allowlist；
- 生成源码拒绝实例元数据地址、Docker Socket、子进程启动和 `file://`。

任务下发和任务回调不是一回事：

- 下发给容器 Runner：用 Provider Token 对 `timestamp.rawBody` 做 HMAC；
- Runner 回调 Nucleus：同时提交 Bearer、Timestamp 和 HMAC；
- Timestamp 超过五分钟、Body 被改一个字节、签名格式错误都会被拒绝；
- Job 只有 `queued/running` 可以进入 `passed/failed`，第二次回调返回 409。

要真正上线容器集群，仍需实现一个遵守该合同的 Provider，并完成网络策略、镜像缓存、节点补丁、漏洞扫描、逃逸测试和容量规划。

## 6. 邮件和告警为什么要用 Outbox

错误做法是先调用邮件服务，再写数据库。如果邮件发出后 Worker 崩溃，数据库以为没发；重试就会给同一个人发两封。

现在的顺序是：

```text
业务事务先写 queued
  -> 调用 Resend/Sentry/Webhook，携带稳定 Idempotency-Key
  -> 成功写 sent
  -> 失败写 attempts / next_attempt_at / error
  -> 小时维护任务领取并重试
  -> 达到 8 次后停止热循环，等待人工处理
```

告警还按 `project + organization + service + operation` 计算 Fingerprint，在冷却窗口内写 `suppressed`，避免一次故障产生几千条值班通知。

## 7. Stripe 权益、发票和超额用量

Stripe 链路包含：

- Checkout Session；
- 原始 Body 签名 Webhook；
- `billing_events` Provider Event ID 幂等；
- Subscription 状态同步；
- `billing_invoices` 发票镜像、金额、币种、Hosted URL 和 PDF；
- Billing Portal；
- `usage_events` 到 Meter Event 的幂等导出。

权益采用 Fail-closed：

| Stripe 状态 | 组织实际套餐 |
|---|---|
| `trialing` / `active` | 订阅套餐 |
| `past_due` | 暂时保留套餐，给支付修复宽限期 |
| `incomplete` / `unpaid` / `paused` / `canceled` | `demo` |

这避免了“Stripe 已取消，但组织表还永久保留 Enterprise 权限”的常见漏洞。

## 8. 移动端局部可视化编辑

旧版本依赖鼠标 `mouseover`，手机没有 Hover，因此用户点元素时可能没有选中目标。现在：

1. `pointerover` 支持鼠标和触控笔；
2. `touchstart` 直接把 `event.target` 设为候选元素；
3. `click` 即使没有 Hover，也会回退到当前 Target；
4. 手机面板固定在底部并考虑 Safe Area；
5. 可编辑文字、背景、文字色、圆角、字号、Padding、Margin、Gap、宽高、Display、Grid Columns 和对齐；
6. “预览修改”只修改 iframe 内联样式；“写入新版本”才把稳定 Selector 和目标属性交给多 Agent 流水线。

## 9. 测试与证据

本轮实际执行：

```powershell
pnpm exec tsc --noEmit
pnpm test
pnpm eval:product
pnpm test:security
pnpm lint
pnpm build
pnpm test:e2e
pnpm test:load
```

结果：

| 门禁 | 实际结果 |
|---|---:|
| Vitest 单元/集成/固定语义契约 | 18 文件，363/363 |
| 产品与安全固定 Eval | 3 文件，283/283 |
| 专项安全 | 17/17 |
| Chromium E2E | 11/11 |
| TypeScript / ESLint / Production Build | 全部通过 |
| 只读并发压测 | 1,000 请求、40 并发、0 失败、P95 2162.62ms |

E2E 中有一条不 Mock API：浏览器通过真实本地 D1 控制面创建草稿、打开工作台、刷新并重新读回；另有一条使用 390×844、Touch Context 验证 DOM 选择和局部预览。

### 9.1 多账号压测

复制示例文件，但真实 Cookie 文件不要提交 Git：

```powershell
Copy-Item evals\load-users.example.json .private\load-users.json
$env:NUCLEUS_LOAD_TARGET='https://你的-staging-域名'
$env:NUCLEUS_LOAD_USERS_FILE='.private/load-users.json'
$env:NUCLEUS_LOAD_SCENARIOS_FILE='evals/load-scenarios.example.json'
$env:NUCLEUS_LOAD_REQUESTS='5000'
$env:NUCLEUS_LOAD_CONCURRENCY='80'
pnpm test:load
```

写场景必须显式设置 `NUCLEUS_LOAD_ALLOW_WRITES=true`，并且只允许在隔离的 staging 数据上运行。

## 10. 外部 Provider 配置清单

### Cloudflare 独立 D1

```dotenv
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_D1_API_TOKEN=
NUCLEUS_D1_LOCATION_HINT=APAC
```

使用最小权限 API Token，不要使用 Global API Key。部署时还需把 `.openai/hosting.json` 中的 `ARCHIVE` 绑定到 R2。

### Resend

```dotenv
RESEND_API_KEY=
NUCLEUS_EMAIL_FROM=Nucleus <invite@你的已验证域名>
```

### Stripe

```dotenv
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_TEAM=
STRIPE_PRICE_ENTERPRISE=
STRIPE_METER_EVENT_NAME=nucleus_usage
```

先在 Test Mode 验证 `checkout.session.completed`、Subscription 更新/删除、`invoice.paid` 和 `invoice.payment_failed`，再切生产。

### 监控与维护

```dotenv
SENTRY_DSN=
NUCLEUS_ALERT_WEBHOOK_URL=
NUCLEUS_MAINTENANCE_TOKEN=
NUCLEUS_SLO_TARGET=0.99
NUCLEUS_SLO_P95_MS=5000
NUCLEUS_ALERT_COOLDOWN_MINUTES=30
```

GitHub Actions 的 `maintenance.yml` 每小时调用一次签名维护接口。必须把站点 URL 和维护 Token 配成仓库 Secrets。

## 11. 上线验收顺序

1. 先部署 staging，应用 `drizzle/0009_harsh_bloodstorm.sql`；
2. 检查 `billing_invoices`、`operational_alerts` 和新增 Outbox/Provisioner 字段；
3. 生成一个带数据集合的新应用，确认资源从 `pending -> provisioning -> ready`；
4. 修改 Schema，确认 `desired_schema_version != schema_version` 后自动迁移并回到一致；
5. 创建备份，确认 Time Travel Bookmark 和 R2 Object 均为 Ready；
6. 在 GitHub App 测试仓库运行一次四 Agent 分支和 Playwright；
7. 修改一次回调 Body，确认 401；重复发送合法回调，确认 409；
8. 用 Stripe Test Clock 或测试卡覆盖成功、失败、取消和发票；
9. 临时让 Resend/Webhook 返回错误，确认 Outbox 出现 `next_attempt_at`，恢复后维护任务发送成功；
10. 跑 9 条 E2E、安全 Eval 和 staging 多账号压测；
11. 查看 Sentry/告警、数据库备份和回滚证据后再切正式域名。

## 12. 面试时可以直接这样说

> 我没有把商业化功能做成一排假按钮。生成版本会声明目标数据库状态，Provisioner 用租约、Revision 和指数退避异步调和真实 D1；Time Travel 负责快速回滚，R2 保存长期导出。GitHub 使用短期 Installation Token，PAT 默认关闭。邮件和告警采用 Outbox-first，Stripe Webhook 同步发票并按状态收回组织权益。外部 Runner 必须遵守只读根文件系统、非 root、Drop Capabilities、网络默认拒绝等合同，双向调用都签名并防重放。当前代码和本地门禁已经完成，但集群、商户、邮件域名和跨云灾备需要真实账号与运维资源，我不会把它们说成已经在线。

这段回答的强点在于：讲清了状态、失败、恢复、安全和真实边界，而不是只罗列技术名词。
