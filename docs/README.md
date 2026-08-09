# Nucleus 文档中心

> 当前生产运行时代码基线：commit `feccdf10ce462a94b070ae629241cb3110dd4aa4`、Sites production version 16、2026-08-09。教学文档本身可以位于该提交之后，不会改变线上运行时代码。

## 想从零照着做

从 [learning/README.md](learning/README.md) 开始。重点入口：

1. [真实施工日志](learning/00-how-we-got-here.md)：这几个小时实际做了什么，故障如何推动每轮修改；
2. [需求与范围](learning/01-requirements-and-scope.md)；
3. [系统架构](learning/02-system-architecture.md)；
4. [前端工作台](learning/03-frontend-workbench.md)；
5. [AI 生成链路](learning/04-ai-generation-pipeline.md)；
6. [预览运行时与安全](learning/05-preview-runtime-and-security.md)；
7. [API、数据库与版本](learning/06-api-database-and-versioning.md)；
8. [测试、故障与质量](learning/07-testing-debugging-and-quality.md)；
9. [Git 与 GitHub](learning/08-git-and-github.md)；
10. [部署与运维](learning/09-deployment-and-operations.md)；
11. [企业开发流程](learning/10-enterprise-development-workflow.md)；
12. [学习练习](learning/11-learning-path-and-exercises.md)；
13. [演示、答辩与术语](learning/12-demo-interview-and-glossary.md)；
14. [从零到生产逐步落地](learning/13-zero-to-production-runbook.md)。

## 想快速理解最终方案

- [企业级开发、部署与排障总手册](ENGINEERING-HANDBOOK.md)
- [www.llynb.cc 自定义域名与长期托管](CUSTOM-DOMAIN-DEPLOYMENT.md)
- [架构与工程取舍](DESIGN.md)
- [提交与 90 秒演示说明](SUBMISSION.md)

## 想知道产品上限和差距

- [MetaGPT 差距分析](METAGPT-GAP-ANALYSIS.md)
- [商业第一梯队能力上限与真实 Demo 基准](UPPER-BOUND-BENCHMARK.md)
- [后续开发计划](DEV-PLAN.md)

## 想审计真实过程

- [逐轮开发与生产验收记录](PROGRESS.md)
- [GitHub Draft PR #2](https://github.com/lilongyong333/nucleus-ai-builder/pull/2)
- [自定义域名在线站点](https://www.llynb.cc)
- [Sites 备用地址](https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site)

## 文档职责

| 文档 | 作为哪类真源 |
|---|---|
| `learning/00` | 真实施工历史和故障因果 |
| `learning/01–12` | 分主题教学 |
| `learning/13` | 可照做的复现/重建/发布 Runbook |
| `CUSTOM-DOMAIN-DEPLOYMENT.md` | 自定义域名、DNS、验收和回滚真源 |
| `DESIGN.md` | 当前架构和关键取舍 |
| `PROGRESS.md` | 每轮验证事实 |
| `UPPER-BOUND-BENCHMARK.md` | 竞品上限和生产样本 |
| `SUBMISSION.md` | 面试交付话术与演示路径 |

如果文档与代码冲突，以当前代码、自动测试、Git commit 和生产审计为最终事实，并在同一 PR 修正文档。
