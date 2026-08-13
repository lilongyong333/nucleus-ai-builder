# 06. API、数据库与版本系统

## 1. API 总表

| 方法 | 路径 | 作用 | 主要返回 |
|---|---|---|---|
| GET | `/api/session` | 当前游客/账号会话 | `{ account }` |
| GET | `/api/projects` | 当前 owner 的最近项目 | `{ projects, account }` |
| POST | `/api/projects` | 创建 draft 项目 | `{ project }` |
| GET | `/api/projects/:id` | 读取一个项目和版本 | `{ project }` |
| POST | `/api/runs` | 显式启动可恢复 Run | `{ runId, project }` |
| POST | `/api/runs/:id/step` | 执行当前 Run 的一个 Agent 阶段 | NDJSON 事件流 |
| POST | `/api/generate` | 旧版单请求生成接口，仅为兼容保留 | NDJSON 事件流 |
| POST | `/api/projects/:id/cancel` | 取消当前生成并撤销租约 | `{ cancelled: boolean }` |
| POST | `/api/projects/:id/restore` | 恢复一个快照 | `{ project }` |
| POST | `/api/projects/:id/publish` | 生成公开 slug | `{ project }` |

API 路由都只做薄编排：解析请求、检查字段、调用 `lib` 服务、把异常转换成 HTTP 响应。

## 2. 为什么先创建项目再生成

创建 `/api/projects` 只需要短事务：

- 生成 UUID；
- 插入 `projects`；
- 插入第一条 user message；
- 返回项目。

模型生成可能几十秒。如果把创建和生成绑在一次普通 JSON 请求里，页面在等待期间没有稳定 ID，也不利于重试和恢复。先得到 project ID，后续所有行为都围绕它进行。

## 3. 八张表

```mermaid
erDiagram
    PROJECTS ||--o{ VERSIONS : has
    PROJECTS ||--o{ MESSAGES : has
    PROJECTS ||--o{ GENERATION_RUNS : has
    GENERATION_RUNS ||--o{ AGENT_EVENTS : has
    GENERATION_RUNS ||--o{ GENERATION_ARTIFACTS : checkpoints
    GENERATION_RUNS ||--o{ MODEL_ATTEMPTS : audits
    PROJECTS {
      text id PK
      text owner_id
      text title
      text prompt
      text status
      text plan_json
      text files_json
      text current_version_id
      text published_version_id
      text generation_id
      text generation_started_at
      text slug UK
      text created_at
      text updated_at
    }
    VERSIONS {
      text id PK
      text project_id
      integer version_number
      text files_json
      text summary
      text model
      text quality_json
      text created_at
    }
    MESSAGES {
      text id PK
      text project_id
      text role
      text content
      text created_at
    }
    GENERATION_LIMITS {
      text key PK
      integer count
      text expires_at
    }
    GENERATION_RUNS {
      text id PK
      text project_id
      text status
      text model
      integer duration_ms
      integer total_tokens
      integer model_calls
      integer repair_count
      text current_stage
      text active_step
      text step_started_at
      text version_id
      text error
    }
    AGENT_EVENTS {
      text id PK
      text run_id
      text project_id
      integer sequence
      text agent
      text phase
      text state
      integer duration_ms
      integer total_tokens
    }
    GENERATION_ARTIFACTS {
      text id PK
      text run_id
      text project_id
      text agent
      text kind
      text content
      text created_at
      text updated_at
    }
    MODEL_ATTEMPTS {
      text id PK
      text run_id
      text agent
      text phase
      text model
      text status
      integer duration_ms
      integer first_token_ms
      integer output_chars
      integer total_tokens
      text error
    }
```

`projects.files_json` 是当前已通过质量门的状态，`versions.files_json` 是历史快照。`generation_runs` 是每轮总账，`agent_events` 是按 sequence 排序的阶段明细，`generation_artifacts` 保存需求、架构、三文件和质量报告检查点，`model_attempts` 保存每一次真实供应商尝试。`owner_id` 控制私有访问，`published_version_id` 固定公开内容，`generation_id` 控制项目级单写者，`active_step` 控制阶段级单写者。

## 4. D1 binding 是什么

部署平台把数据库实例以 `DB` 名称注入 Worker 环境。代码通过：

```ts
const binding = env.DB;
binding.prepare("SELECT ... WHERE id = ?")
  .bind(id)
  .first();
```

`?` 占位符和 `.bind()` 避免把用户输入拼进 SQL，从而降低 SQL 注入风险。

## 5. Schema 与 migration

- `db/schema.ts`：Drizzle 的 TypeScript schema，是开发时的数据模型声明；
- `drizzle/*.sql`：可部署、可追踪的数据库变更；
- `lib/db.ts` 的 `ensureSchema()`：运行期防御性创建表和索引。

`ensureSchema()` 把初始化 Promise 缓存在 Worker 实例中，避免同一实例每次请求都重复发建表 SQL；失败时清空缓存，下一次可以重试。

成熟企业系统通常由部署流水线在流量切换前执行 migration，不会把所有 migration 责任放在请求路径。当前双保险适合 Demo，但生产升级复杂表结构时应改为正式 migration gate。

## 6. 项目状态机

```mermaid
stateDiagram-v2
    [*] --> draft: 创建项目
    draft --> generating: 首次生成
    ready --> generating: 继续修改
    generating --> ready: 保存版本成功
    generating --> error: 模型/解析/数据库失败
    generating --> draft: 首轮取消
    generating --> ready: 迭代取消，保留旧版本
    error --> generating: 用户重试
```

状态用于 UI 提示，不替代版本记录。真正的代码内容以 `files_json` 和 `versions` 为准。

Run 内部还有一条更细的持久化状态机：

```text
requirements → architecture
→ implementation:index.html
→ implementation:styles.css
→ implementation:script.js
→ quality → repair → quality
→ finalize → completed
```

每一步最多只执行一个模型阶段。页面刷新时读取 `current_stage` 和已有 Artifact 继续，而不是重新从 Iris 开始。

## 7. 保存一个版本

`saveGeneration()` 的逻辑：

1. 查询当前版本数量，得到下一个 `versionNumber`；
2. 创建 `versionId`；
3. batch 插入 version 全量文件；
4. 更新 project 当前文件、计划、标题、状态和 currentVersionId；
5. 插入 assistant message；
6. 重新读取完整 project 返回给前端。

这些写操作放在 D1 batch 中，减少网络往返，也让相关操作更集中。

并发现在由两级数据库租约而不是前端按钮控制：`beginGeneration()` 原子写入随机 `generation_id`，同项目第二个 Run 返回 409；`acquireGenerationStep()` 再为一个阶段写入随机 `active_step`，重连和双标签不能重复执行同一阶段。完成、失败、取消、Artifact、Attempt、Event 和 Version 写入都要求 Run 仍是 `running`。`versions(project_id, version_number)`、`generation_artifacts(run_id, kind)` 和 `agent_events(run_id, sequence)` 还有唯一索引作为最后防线。

## 8. 为什么用全量快照

恢复版本只需：

```sql
UPDATE projects
SET files_json = <version.files_json>,
    current_version_id = <version.id>
WHERE id = <project.id>;
```

不用依次回放补丁，也不会因为中间差量损坏导致后续版本都无法恢复。三文件通常只有几十 KB，全量快照的空间成本在 Demo 阶段可接受。

注意：恢复旧版本不会删除新版本。用户可以恢复 v1，再恢复 v2。

## 9. 发布链接

发布时生成：

```text
<规范化标题>-<project-id前6位>
```

并写入唯一 `slug`。公开页根据 slug 读取 `published_version_id` 对应快照并显示全屏预览。

系统明确选择固定发布：

- 后续继续生成只改变 `current_version_id`；
- 公开页保持旧版本；
- 用户再次点击发布，才把 `published_version_id` 更新到当前版本；
- 私有草稿、对话和运行审计不会出现在公开页。

## 10. 游客、登录账号与项目迁移

`resolveWorkspaceIdentity()` 把调用者映射成 owner：

- 登录：`chatgpt:<受信 user id>`；
- 未登录：HttpOnly Cookie 中的随机 visitor ID。

第一次登录时，当前 visitor owner 的项目一次性迁移到账户 owner。迁移只改变所有权，Version、Message、GenerationRun、AgentEvent 和公开 slug 仍通过 project ID 保持关联。

所有私有查询都带 owner 条件；非所有者统一得到 404。系统不接受浏览器 body 中随意传入的 user ID，只读取 Sites 注入的受信身份头。

## 11. 匿名限流

公网站点会消耗模型套餐额度。生成接口选择客户端标识：

1. Cloudflare IP header；
2. 代理转发 IP；
3. 真实 IP header；
4. 最后退化为 User-Agent。

然后：

- 使用 SHA-256 哈希；
- 只取部分摘要，不保存明文 IP；
- 以小时组成 bucket key；
- 用 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING count` 原子递增；
- 正式 `/api/runs` 主链路默认每小时最多 20 次（旧兼容接口仍为 8 次）；
- 返回 429 和 `Retry-After: 3600`。

这是成本保护，不是可靠身份认证。NAT 用户可能共享额度，攻击者也可能绕过。生产系统应基于登录用户、项目套餐、全局预算、WAF 和异常检测组合限流。

## 12. HTTP 错误码

| 状态码 | 含义 | 示例 |
|---|---|---|
| 200 | 请求成功 | 项目读取、流已建立 |
| 201 | 资源创建成功 | 创建项目 |
| 400 | 请求字段错误 | prompt 太短、JSON 格式错误 |
| 404 | 资源不存在 | 项目或版本不存在 |
| 409 | 状态冲突 | 同项目已经有生成租约 |
| 429 | 超过限流 | 本小时生成次数耗尽 |
| 500 | 服务端异常 | D1 或未预期错误 |

生成过程中发生错误时，HTTP 可能已经是 200，因为响应流已开始。此时用 NDJSON 的 `{ "type": "error" }` 通知浏览器。

## 13. 数据读取边界

- 项目列表只返回轻量项目，不携带完整私有审计 payload；
- 项目详情最多读取 100 条消息、10 次运行、200 个事件、200 个工件和 200 次模型尝试；
- 公开页只读固定 Version；
- 账号中心显示工作台/公开页 URL，但不把 API Key、owner ID 或完整模型回复暴露给页面。

这些上限防止一个长期项目无限扩大单次响应。

## 14. 官方延伸阅读

- [Cloudflare D1 Worker Binding API](https://developers.cloudflare.com/d1/worker-api/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
