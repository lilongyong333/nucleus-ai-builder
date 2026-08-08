# Nucleus 开发进度与验收记录

最后更新：2026-08-09

## 完成度

| 阶段 | 状态 | 结果 |
|---|---|---|
| 工程基线 | ✅ | 独立 Git 仓库、依赖锁定、密钥隔离 |
| 产品界面 | ✅ | 落地页、响应式三栏工作台、代码/预览切换 |
| AI 生成 | ✅ | OpenCode Go 规划 + 构建两阶段调用 |
| 运行时 | ✅ | 三文件组装、sandbox、错误桥、storage shim |
| 数据持久化 | ✅ | D1 schema、migration、运行期初始化 |
| 版本系统 | ✅ | 自动快照、列表、恢复任意版本 |
| 发布与导出 | ✅ | `/p/[slug]`、公开链接、ZIP 下载 |
| 质量验证 | ✅ | 测试、类型、lint、生产构建、真实 E2E |
| 在线部署 | ✅ | 公网站点、D1、服务端密钥和真实生成均已验证 |
| 公开源码 | ✅ | GitHub Public 仓库已推送，PDF 和密钥未入库 |

## API 与模型验证

- OpenCode Go `/models` 返回 25 个模型；
- `kimi-k2.7-code` 与 `glm-5.2` 冒烟调用成功；
- `deepseek-v4-flash` 在当前套餐返回 403，因此没有作为默认模型；
- `kimi-k2.7-code` 完整页面输出超过 180 秒；
- `glm-5.2` 完整生成实测约 32 秒，因此选为默认模型。

不是“调用所有模型后选最好”：这样会浪费套餐额度和时间。这里先查询完整列表，再对代表性代码模型做可用性与延迟验证。

## 真实端到端验收

测试需求：旅行预算规划器。

### 第一轮

- 创建项目成功，状态 `draft`；
- Planner 输出功能和视觉计划；
- Builder 32 秒内输出 `index.html`、`styles.css`、`script.js`；
- 文件体积约为 4.5KB / 8.7KB / 6.3KB；
- JavaScript `node --check` 通过；
- HTML 包含表单和按钮，JS 包含事件监听；
- v1 快照保存成功。

### 第二轮

修改需求：增加浅色 / 深色主题并记住选择。

- 首次模型只返回变化文件，旧解析器把缺少 `styles.css` 当成失败；
- 修复为“新文件覆盖、未返回文件沿用当前版本”的增量合并；
- 重试成功，生成 v2；
- 生成物包含主题切换逻辑；
- 恢复 v1 成功，再恢复 v2 成功。

### 发布

- 发布接口生成 slug；
- 公开页 HTTP 200；
- 页面包含全屏预览 iframe。

## 自动化结果

```text
Vitest          6 / 6 passed
TypeScript      passed
ESLint          passed
Production      passed
```

## 开发中发现并解决的问题

1. `pnpm` 默认阻止 `esbuild` / `workerd` 构建脚本：在 workspace 配置中精确允许。
2. Vinext 测试误加载 Cloudflare Vite 插件：增加独立 `vitest.config.ts`。
3. 大 JSON 代码输出转义失败：改为 path code fence 协议。
4. 增量修改偶尔只返回一个文件：与当前快照合并。
5. sandbox opaque origin 无法直接访问 `localStorage`：注入内存兼容层。
6. 旧 `.next` 类型污染 Vinext 类型检查：隔离旧构建产物，并让 ESLint 忽略 artifacts。
7. 线上 Builder 偶发返回空内容：增加一次自动重试，并在 reasoning 中包含完整 artifact 时容错提取。
8. 首轮生成偶发漏文件：检测缺失路径并发起一次定向补全，最终线上生成 13 个事件并成功保存 v1。

## 正式线上验收

- 站点：https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site
- 源码：https://github.com/lilongyong333/nucleus-ai-builder
- 首页 HTTP 200，Nucleus 产品内容正常；
- `/api/projects` HTTP 200，D1 migration 正常；
- 线上创建“习惯打卡器”项目成功；
- 线上生成 HTTP 200，13 个 NDJSON 事件，最终状态 `ready`；
- `index.html`、`styles.css`、`script.js` 三文件齐全；
- 线上 v1 版本写入成功；
- 发布页 `/p/app-c4fbb7` HTTP 200，并包含全屏预览 iframe。

## 当前限制

- 生成物只支持浏览器前端三文件；
- 不能安装任意 npm 包；
- 生成应用的 storage 在每次预览页面生命周期内有效，不是 Nucleus D1 数据；
- 公开链接通过随机化 slug 分享，尚未实现细粒度权限；
- 默认模型响应通常需要 25–60 秒，取决于输出规模和服务负载。
