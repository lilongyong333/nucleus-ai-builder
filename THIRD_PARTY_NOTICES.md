# 第三方参考与许可证说明

## LlamaCoder

- 上游仓库：https://github.com/Nutlope/llamacoder
- 审阅基线：`d840d878c6ef9dd363868a382a7ff04011037bb4`
- 许可证：MIT

开发前对 LlamaCoder 的模型输出解析、虚拟文件、iframe 预览和错误桥接设计进行了审阅。最终 Nucleus 为适应三文件、Cloudflare Worker 和本题范围，独立实现了更小的运行时；当前仓库没有逐文件复制上游源码。

受上游验证影响的工程思路包括：

- 用带 `path` 的代码围栏传输多文件，避免大段 JSON 的转义和截断问题；
- 不在服务端执行生成代码，而是在 sandbox iframe 内运行；
- 把 `error` / `unhandledrejection` 通过 `postMessage` 交回工作台；
- 为 opaque-origin iframe 提供内存版 `localStorage` 兼容层。

## npm 依赖

React、Vinext、Drizzle ORM、JSZip、Lucide 和 Vitest 等依赖通过 `package.json` 与 `pnpm-lock.yaml` 锁定，按各自许可证使用，未复制其源码到本仓库。
