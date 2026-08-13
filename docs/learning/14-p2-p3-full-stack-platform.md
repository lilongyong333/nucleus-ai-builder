# 14. P2/P3 全栈平台升级：从网页生成器到应用运行平台

这一轮的目标不是在工作台里再放十几个“看起来像功能”的按钮，而是给每一个生成应用补上可验证的运行时资源。完成后，一份生成结果不再只有 `index.html`、`styles.css`、`script.js`，还会拥有一份版本化 `AppManifest`，由它声明这个应用的 API、数据 Schema、Auth、依赖、验收项和外部执行能力。

## 1. 最重要的结论

当前版本已经真正落地的能力：

- 每个已保存版本都有独立 `AppManifest`；
- 每个应用都有独立 API 基路径 `/api/app-runtime/:projectId`；
- 每个应用按 `projectId + collection` 做强制数据隔离，并按自己的 Schema 校验写入；
- 每个应用使用独立、可续期、只保存哈希的运行时 Session；
- 预览和公开应用都能调用 `window.nucleus.data` 完成持久化 CRUD；
- Console、运行时异常、DOM 摘要和浏览器 Runner 结果会保存为生产证据；
- 可创建应用数据备份，恢复前自动再建一个检查点；
- Race Mode 会并行生成候选代码、评分、择优并保留审计记录；
- 可在预览中选中 DOM 元素，先做即时视觉 Patch，再让 Alex/Ray 写入正式新版本；
- 组织成员、角色、邀请、发布审批、Token 用量预算已成为后端状态；
- GitHub 分支和外部 Runner 都有真实 Provider 协议与失败状态。

需要部署者提供凭据或外部基础设施后才能执行的能力：

- GitHub 自动建 Iris/Bob/Alex/Ray 分支并合并；
- GitHub Actions 云端 Playwright 点击验收；
- 安装 npm、pip、系统包，或启动 Node/Python/Java/自定义镜像的隔离容器。

这三项在缺少服务端凭据时返回 `configuration-required`，不会返回假成功。

## 2. 为什么要有 AppManifest

没有 Manifest 时，平台只知道“模型给了三段代码”，不知道代码需要什么数据、谁能写数据、要安装什么依赖，也无法可靠地安排验收。

核心类型位于 `lib/types.ts`：

```ts
type AppManifest = {
  projectId: string;
  versionId: string;
  backend: { basePath: string; functions: AppBackendFunction[] };
  database: {
    provider: "nucleus-d1";
    isolation: "project-namespace";
    collections: AppCollectionSchema[];
  };
  auth: { provider: "nucleus-app-session"; mode: "anonymous" | "account" | "mixed" };
  dependencies: {
    npm: string[];
    pip: string[];
    system: string[];
    containers: string[];
    execution: "edge-native" | "external-runner-required";
  };
  acceptance: { checks: string[]; browserJobRequired: boolean };
};
```

生成链路中，Bob 负责提出 Runtime Blueprint；`lib/app-manifest.ts` 负责白名单清洗、补默认值、拒绝危险名称并生成最终 Manifest。这样既能利用模型理解需求，也不会让模型直接决定数据库表名或执行任意命令。

## 3. “独立数据库”在当前架构中的准确含义

当前生产部署只有一个 Cloudflare D1 binding。它不能在一次普通 Worker 请求里动态创建任意多个新的 D1 binding，因此当前实现是“逻辑独立数据库”，不是“一应用一个物理 D1 实例”。

隔离键是：

```text
project_id
  └── collection
       └── record_id
```

所有读取、更新、删除 SQL 都必须包含 `project_id`；集合必须存在于该应用 Manifest；字段必须通过对应 Schema 校验。应用 A 即使猜到应用 B 的记录 ID，也不能越过 `project_id` 条件读取。

这种模式适合当前演示平台：成本低、迁移简单、可统一备份与监控。如果未来做到企业级物理隔离，可以把 Manifest 的 `database.provider` 扩展为独立 D1、Neon、Supabase 或客户自带数据库，并保留同一 Runtime API 契约。

## 4. 每应用 API 与 SDK

公开的运行时路由为：

```text
POST   /api/runtime/:slug/session
POST   /api/projects/:id/runtime/session
GET    /api/app-runtime/:projectId/records/:collection
POST   /api/app-runtime/:projectId/records/:collection
PATCH  /api/app-runtime/:projectId/records/:collection/:recordId
DELETE /api/app-runtime/:projectId/records/:collection/:recordId
POST   /api/app-runtime/:projectId/events
```

生成应用不需要自己拼 HTTP Header，而是使用注入到 iframe 的 SDK：

```js
const tasks = await window.nucleus.data.list("tasks");
const created = await window.nucleus.data.create("tasks", {
  title: "完成演示",
  done: false,
});
await window.nucleus.data.update("tasks", created.id, {
  done: true,
  _revision: created.revision,
});
await window.nucleus.data.remove("tasks", created.id);
```

SDK 会自动附加应用 Session Bearer Token。更新使用 `_revision` 做乐观并发控制：如果两个浏览器同时修改同一条数据，后到请求会得到 `409`，不会静默覆盖先到请求。

## 5. 每应用 Auth

工作台预览 Session 继承组织角色；公开应用 Session 则映射为已登录账号或匿名访问者。数据库只保存访问 Token 与 Refresh Token 的 SHA-256 哈希，不保存原始凭据。

角色对运行时数据的影响：

| 角色 | 读取 | 创建/修改自己的记录 | 管理所有记录 |
|---|---:|---:|---:|
| owner/admin | 是 | 是 | 是 |
| editor | 是 | 是 | 是 |
| reviewer/viewer | 是 | 否 | 否 |
| public user | 由集合 access 决定 | 由集合 access 决定 | 否 |

集合还可以声明 `owner`、`public-read` 或 `public-write`。角色和集合策略必须同时允许，请求才会成功。

## 6. 数据备份与恢复

`app_backups` 保存应用记录快照。恢复流程是：

1. 检查项目权限与备份归属；
2. 自动创建“恢复前备份”；
3. 清理当前项目命名空间；
4. 按最多 80 条 SQL 一批恢复，避免超过 D1 batch 上限；
5. 恢复完成后再创建“已恢复”检查点。

单次内置备份最多 5,000 条记录和约 1.8MB JSON。超过这个范围时会返回 `413`，要求接入对象存储或专业备份 Provider。这个限制是明确的产品边界，不会偷偷丢数据。

## 7. 关键数据表

本轮增加的主要表：

| 表 | 作用 |
|---|---|
| `app_manifests` | 当前应用版本的 API/Schema/Auth/依赖契约 |
| `app_sessions` | 哈希化运行时 Session 与角色 |
| `app_records` | 按项目和集合隔离的应用数据 |
| `runtime_evidence` | Console、异常、DOM、Runner 证据 |
| `app_backups` | 应用数据快照 |
| `runner_jobs` | 外部浏览器/容器任务状态 |
| `race_candidates` | 多模型候选、得分和最终选择 |
| `organizations` | 团队、套餐、审批策略与月度额度 |
| `organization_members` | 成员、邀请、角色和状态 |
| `project_approvals` | 版本发布审批 |
| `usage_events` | Token、模型调用和数据写入用量 |
| `git_integrations` | 仓库连接和最近同步审计 |

对应 Drizzle 模型在 `db/schema.ts`，SQL migration 为 `drizzle/0007_robust_gravity.sql`。

## 8. 安全边界

- 模型只能声明经过白名单清洗的集合、字段、依赖和函数；
- 生成代码仍在不含 `allow-same-origin` 的 sandbox iframe 中运行；
- Runtime API 以 Bearer Session 鉴权，并再次校验 `projectId`；
- 数据字段只接受 string、number、boolean、date、json 五类；
- 单条记录、日志、Manifest、Runner 请求均有大小上限；
- 容器只由外部隔离 Runner 执行，Worker 不执行模型生成的 shell 命令；
- GitHub Token、Runner Token 和模型 Key 只允许放在服务端 Secret；
- 已经公开粘贴过的 API Key 应立即在提供商控制台撤销并重新生成。

## 9. 如何判断它不是 PoC

可以用下面的闭环验收：

1. 新建应用并生成正式 v1；
2. 在“应用全栈资源”看到该版本的 Manifest 与 Schema；
3. 让生成应用通过 `window.nucleus.data.create` 写入一条记录；
4. 刷新页面并确认数据仍存在；
5. 创建备份，修改或删除记录，再恢复备份；
6. 在生产证据中看到运行日志；
7. 开启发布审批，提交、通过，再发布；
8. 开启 Race Mode，确认候选模型、评分和被选结果被持久化；
9. 选中预览 DOM，修改文字或样式，先预览再生成新版本；
10. 未配置外部 Provider 时，Runner 显示 `configuration-required`；配置后才允许进入 `queued/running/passed/failed`。

这套链路有真实状态、持久化、权限、失败和恢复，不是只在前端播放多 Agent 动画。
