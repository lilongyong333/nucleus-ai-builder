# 16. 团队协作、审批、用量、日志、备份与回滚

本章从企业开发流程解释 Nucleus 的控制面。重点是：谁可以做什么、每次操作留下什么证据、失败后如何恢复。

## 1. 组织与成员

每个项目归属于一个 Organization。个人首次创建项目时会自动获得个人工作区和 owner 成员。邀请协作者时，系统保存标准化邮箱和邀请状态；对方使用相同邮箱登录后，`claimOrganizationInvites` 会把邀请绑定到稳定账号 Subject。

当前邀请不会发送邮件。它是完整的后端邀请/认领状态，但邮件投递 Provider 尚未接入。演示时应说“邀请已记录，对方同邮箱登录后加入”，不能说“邮件已发送”。

## 2. RBAC 权限矩阵

| 操作 | owner | admin | editor | reviewer | viewer |
|---|---:|---:|---:|---:|---:|
| 查看项目/运行/日志 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 启动、继续、取消生成 | ✓ | ✓ | ✓ |  |  |
| 修改应用数据 | ✓ | ✓ | ✓ |  |  |
| 创建备份 | ✓ | ✓ | ✓ |  |  |
| 恢复数据备份 | ✓ | ✓ |  |  |  |
| 配置 GitHub 仓库 | ✓ | ✓ |  |  |  |
| 执行 Git/Runner | ✓ | ✓ | ✓ |  |  |
| 发起发布审批 | ✓ | ✓ | ✓ | ✓ |  |
| 通过/拒绝审批 | ✓ | ✓ |  | ✓ |  |
| 修改组织策略/邀请成员 | ✓ | ✓ |  |  |  |

权限不只由前端禁用按钮控制。项目查询、生成 lease、运行时 Session、Runner、Git、备份和审批 API 都在服务端检查角色。

## 3. 发布审批

组织可开启 `approval_required`：

1. editor 完成一个 Ray 通过的版本；
2. 提交 `project_approvals`；
3. owner/admin/reviewer 在全栈资源抽屉通过或退回；
4. `/publish` 再次读取当前 Version 的最新审批；
5. 没有通过时返回 409；
6. 通过后发布固定到明确的 `published_version_id`。

发布后继续修改草稿，不会静默改变公开版本。必须再次通过审批并重新发布。

## 4. 用量与预算

当前记录三类 Usage Event：

- `model_tokens`：模型实际 Token；
- `model_calls`：模型请求次数；
- `database_write`：生成应用写数据库次数。

组织的 `monthly_token_limit` 是硬预算门。启动生成前会汇总当月 Token；超过上限返回 429。

这不是完整计费系统。当前没有 Stripe、发票、退款、税务、套餐订阅或เงินจริง扣款。`plan` 和用量是计费控制面的数据基础，不应称为“已完成商业计费”。

## 5. 运行日志与监控

日志分为三层：

| 层 | 数据 | 保存位置 |
|---|---|---|
| 生成审计 | AgentEvent、Artifact、ModelAttempt、Token、耗时 | D1 generation 表 |
| 应用运行时 | Console、error、unhandled rejection、DOM 摘要 | `runtime_evidence` |
| 外部执行 | Runner 状态、点击、网络、截图、构建日志摘要 | `runner_jobs` + `runtime_evidence` |

`runtimePlatformStats` 汇总 Session、记录、错误、备份、Runner 等数量，在工作台形成轻量监控面板。

当前不是 Datadog/Sentry 替代品：没有长期指标时序库、跨服务 Trace、PagerDuty 告警和自定义仪表盘。生产企业版可以把 Runtime Event 同步到 Sentry、OpenTelemetry、Cloudflare Analytics Engine 或日志仓库。

## 6. 数据备份与版本回滚是两件不同的事

- Version 回滚：恢复 HTML/CSS/JavaScript + AppManifest，解决“代码改坏”；
- Data Backup 恢复：恢复 `app_records`，解决“运行数据改坏或误删”。

代码版本恢复不会覆盖应用运行数据；数据恢复也不会改变当前代码版本。这种分离能避免一次回滚造成第二次事故。

## 7. 故障恢复手册

### 模型超时或截断

- 当前阶段保留在 `generation_runs.current_stage`；
- 已完成 Artifact 不丢失；
- ModelAttempt 记录 timeout/incomplete；
- 下一请求只重跑未完成阶段；
- 达到总预算后明确失败，不写入假 Version。

### 浏览器断流

- Worker 仍在运行时，客户端轮询项目状态；
- 页面刷新后从 D1 重建时间线；
- 运行完成后恢复 Version；
- 超过 lease TTL 的任务自动回收。

### 运行时 Console error

- iframe 即时发回宿主；
- 批量写入 runtime evidence；
- 每版本最多自动回灌 Ray 一次；
- 修复仍要通过 Ray 质量门。

### Playwright 失败

- Callback 保存截图、Console、网络与点击证据；
- `claimBrowserRunnerRepair` 原子标记 `processed_at`；
- 工作台领取后发起修复 Run；
- 保留原 Job 作为审计证据。

### 数据误删

- 选择最近备份；
- 恢复前系统自动创建当前快照；
- 恢复后抽样读取关键集合；
- 若恢复结果不对，可用“恢复前备份”再次回退。

## 8. 企业化下一步

要进入成熟商用层级，还要补：

- 邮件/站内邀请通知；
- 多组织切换和项目转移；
- SSO/SAML/SCIM；
- 自定义角色和资源级 Policy；
- 审批人规则、多人会签、超时提醒；
- Stripe/账单/发票/配额购买；
- 审计日志导出和不可篡改存储；
- 自动定时备份、跨区域对象存储和灾难恢复演练；
- SLO、告警、Trace、指标保留周期；
- 数据保留、删除请求和合规策略。

当前实现已经把这些能力需要的核心实体和授权边界放进产品，而不是把它们画在 PPT 里；但上述企业服务仍应诚实列为后续路线。
