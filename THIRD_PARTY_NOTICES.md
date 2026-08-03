# 第三方代码与许可证声明

本项目在构建过程中复用了下列开源项目的代码。所有复用均保留原许可证，并在本文件中列明具体范围。
每个复用文件的头部也带有指向上游的注释。

---

## Nutlope/llamacoder

- **仓库**：https://github.com/Nutlope/llamacoder
- **许可证**：MIT
- **基线 commit**：`<待 S1.1 填入>`
- **克隆时间**：`<待 S1.1 填入>`

### 复用范围

| 本项目路径 | 上游来源 | 说明 |
|---|---|---|
| `lib/runtime/*` | `<待 S1.1 确认具体路径>` | 浏览器内预览运行时：esbuild-wasm 编译 + esm.sh 依赖解析 + sandboxed iframe 执行 |

### 在此基础上的改动

- 增加运行时错误 / 编译错误经 `postMessage` 回传父页的桥接
- 增加 iframe 内截图能力（`html-to-image`），支持桌面 / 移动双视口捕获
- 适配本项目的虚拟文件系统数据结构与事件协议

### 未复用的部分

上游的 Agent 编排、UI、数据层、模型接入（Together AI / Llama 3.1）均**未使用**，
本项目的对应模块为独立实现（见 README「本项目自研部分」）。

### MIT License 原文（Nutlope/llamacoder）

```
<待 S1.1 从上游仓库 LICENSE 文件原样粘贴>
```

---

## 其他直接依赖

常规 npm 依赖（Next.js、React、Tailwind CSS 等）的许可证随 `package.json` /
`pnpm-lock.yaml` 声明，未做源码级复制，不在本文件逐一列举。
