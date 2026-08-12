# Nucleus 文档中心

> 当前代码基线：`agent/metagpt-quality-gate` 分支 2026-08-12 商业化加固版。发布门为 Vitest 340/340、产品/安全 Eval 283/283、专项安全 17/17、Chromium E2E 9/9，并完成 1,000 请求/40 并发基线。代码、Sites 部署和外部 Provider 账号是否已配置是三个不同状态，文档分别标注。

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
14. [从零到生产逐步落地](learning/13-zero-to-production-runbook.md)；
15. [P2/P3 全栈平台升级](learning/14-p2-p3-full-stack-platform.md)；
16. [Race、可视化编辑、Runner 与 Git](learning/15-race-visual-runner-git.md)；
17. [团队协作与生产运维](learning/16-team-operations-observability.md)；
18. [P2/P3 部署与验收](learning/17-p2-p3-deployment-acceptance.md)；
19. [Python 手撕多 Agent](learning/18-python-multi-agent-from-scratch.md)；
20. [商业化加固与 Provider 落地](learning/19-commercial-hardening-and-provider-runbook.md)。

## 想快速理解最终方案

- [企业级开发、部署与排障总手册](ENGINEERING-HANDBOOK.md)
- [www.llynb.cc 自定义域名与长期托管](CUSTOM-DOMAIN-DEPLOYMENT.md)
- [架构与工程取舍](DESIGN.md)
- [ROOT 笔试简要说明与 3 分钟演示](SUBMISSION.md)
- [可直接发送给 HR 的笔试说明 PDF](../output/pdf/Nucleus-ROOT-Fullstack-Written-Test-Li-Longyong.pdf)

## 想知道产品上限和差距

- [MetaGPT 差距分析](METAGPT-GAP-ANALYSIS.md)
- [商业第一梯队能力上限与真实 Demo 基准](UPPER-BOUND-BENCHMARK.md)
- [后续开发计划](DEV-PLAN.md)

## 想审计真实过程

- [逐轮开发与生产验收记录](PROGRESS.md)
- [GitHub Draft PR #2](https://github.com/lilongyong333/nucleus-ai-builder/pull/2)
- [自定义域名在线站点](https://www.llynb.cc)
- [本轮真实生成的贪吃蛇成品](https://www.llynb.cc/p/responsive-snake-game-d1bf0e)
- [贪吃蛇项目工作台与完整审计](https://www.llynb.cc/w/d1bf0eb6-4b74-48d0-984e-ebaa773cbb3c)
- [Sites 备用地址](https://nucleus-ai-builder-root.dreamy-joy-4746.chatgpt.site)

## 文档职责

| 文档 | 作为哪类真源 |
|---|---|
| `learning/00` | 真实施工历史和故障因果 |
| `learning/01–12` | 核心功能的分主题教学 |
| `learning/13` | 可照做的复现/重建/发布 Runbook |
| `learning/14–17` | P2/P3 全栈、Race、Runner、协作、运维和部署验收 |
| `learning/18` | Python 初学者可手撕的多 Agent API 协作闭环 |
| `learning/19` | Provisioner、长期备份、GitHub App、Stripe、Outbox、安全和压测真源 |
| `CUSTOM-DOMAIN-DEPLOYMENT.md` | 自定义域名、DNS、验收和回滚真源 |
| `DESIGN.md` | 当前架构和关键取舍 |
| `PROGRESS.md` | 每轮验证事实 |
| `UPPER-BOUND-BENCHMARK.md` | 竞品上限和生产样本 |
| `SUBMISSION.md` | 面试官可直接阅读的架构、功能、创新、取舍和完成度说明 |

如果文档与代码冲突，以当前代码、自动测试、Git commit 和生产审计为最终事实，并在同一 PR 修正文档。
