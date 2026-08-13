# 为什么把 Token 调成“无限”仍然生成失败

> 这篇文档来自 2026-08-12 的一次真实生产故障：一个中文打字速度测试在 Iris 完成后，Bob 连续失败，最终没有进入 Alex 写代码阶段。

## 1. 先说结论

这次失败与 Run 的 Token 总上限无关。当时生产配置允许单次 Run 使用最多 180,000 Tokens、24 次模型调用；失败 Run 实际只用了 15,060 Tokens、10 次调用。当前配置后来已提高到 500,000 Tokens、60 次调用，但仍保留硬边界。真正原因是：

1. 一个 Bob 响应已经 HTTP 200 并返回 3,905 个字符，但不符合 JSON 工件协议；
2. 备用模型多次返回 3,000–4,000 个字符，却没有发送流结束事件；
3. 网关把所有模型都发往 `/chat/completions`，但 OpenCode Go 当前文档要求 `gpt-5.6-luna` 使用 `/responses`；
4. 旧逻辑把“缺结束事件”和“内容真的被截断”都视为失败；
5. 上层随后把整个 Bob 阶段重新执行三遍，消耗更多时间和 Token，却没有改变失败条件。

因此，把 180,000 改成更大的数字不会救回已经完整但缺少结束事件的 JSON，也不会把格式错误的 JSON 自动变正确。

## 2. 四种容易混淆的上限

| 上限 | 控制什么 | 当前示例 | 能否无限 |
|---|---|---:|---|
| `max_tokens` | 一次模型回答最多生成多少 Token | Bob 7,000 | 不能，受模型与 Provider 限制 |
| Run Token Budget | 整条 Iris/Bob/Alex/Ray 流水线累计用量 | 180,000 | 不应无限，否则故障循环会无限收费 |
| Model Call Budget | 一条 Run 最多调用几次模型 | 24 | 不应无限，否则错误 Prompt 可永远重试 |
| 时间预算 | 一个 Worker 请求和一个阶段能运行多久 | 每阶段约 52–60 秒 | 不能，受云运行时、网络和用户体验限制 |

`max_tokens=7000` 的意思是“最多允许模型输出 7000 Tokens”，不是“保证模型一定输出 7000 Tokens”，更不是“这个 HTTP 流永远不会中断”。

## 3. 这轮怎么修

### 3.0 先把模型发到正确协议

OpenCode Go 不是所有模型共用同一种 HTTP 协议。网关现在按模型路由：

- `gpt-*` 使用 `/responses`、`max_output_tokens`，并解析 `response.output_text.delta`、`response.completed`、`response.incomplete` 与 `response.failed`；
- `glm-*` 继续使用 `/chat/completions`、`max_tokens`，并解析 OpenAI-compatible Chat Completions SSE；
- 两套协议最终都归一为同一种内容、用量、完成原因和审计记录；Responses API 的 `input_tokens/output_tokens` 也会计入统一预算。

这是协议修复，不是“换个模型碰运气”。生产尝试里 GPT 多次有正文却缺少 Chat Completions 终止事件，与端点错配现象一致；我们把它列为有生产证据支持的根因推断，而不把单次日志夸大为绝对证明。

### 3.1 完整工件救回

`lib/model-gateway.ts` 现在把传输状态和工件状态分开判断：

- `finish_reason=length`：明确截断，继续拒绝；
- 用户取消：继续拒绝；
- 流缺少 `[DONE]` 或在末尾超时：先检查工件结构；
- JSON 括号完整且能安全解析，或单文件代码块完整且通过协议：标记 `recovered` 并继续；
- 工件不完整：仍然失败或切换备用模型。

这个策略不是“忽略错误”，而是“不因为快递员忘记说送达，就扔掉已经完整签收的包裹”。

### 3.2 保守确定性降级

Iris、Bob、Ray 属于计划和审查阶段。Provider 确实没有形成可解析工件时：

- Iris 根据原始 Prompt 生成最小可验收需求契约；
- Bob 根据 Iris 工件生成固定三文件职责、状态模型、测试计划和默认 Runtime Blueprint；
- Ray 使用 Acorn 语法检查、通用质量门和应用类型专项契约做保守审查；
- 每次降级都会写入 `AgentEvent`，模型尝试仍保留，界面明确显示“确定性恢复”，不会冒充模型成功。

Alex 仍必须真正生成代码。代码文件不能用预制 Demo 假装生成成功；只有三文件齐全并通过 Ray/确定性质量门，才会保存 v1。

### 3.3 避免无意义整阶段重跑

旧版本允许同一规划阶段失败三次。新版本在可恢复的 Provider/解析故障后直接生成可审计的保守工件并进入下一阶段，因此不会再把 6 次调用浪费在同一个 Bob JSON 上。

认证失败、限流等纯 HTTP 错误不会被伪装成恢复成功；只有空响应、不完整流、超时、网络中断或已返回但无法解析的规划工件才允许降级。

### 3.4 应用类型质量契约

中文打字测试新增四项硬检查：

1. 存在真实 `input/textarea` 和 `input/compositionend` 处理；
2. 存在正确率、WPM/CPM 和计时计算；
3. 存在题库与随机选择逻辑；
4. 存在成绩展示和重新测试流程。

这样即使页面很漂亮，只要不能真正打字、统计或展示成绩，Ray 仍会拒绝发布。

## 4. 代码从哪里读

- `lib/model-gateway.ts`：按模型选择 Responses/Chat Completions、主备模型、SSE、超时和完整工件救回；
- `lib/structured-output.ts`：不执行模型文本的 JSON/代码结构验证；
- `lib/opencode.ts`：Iris、Bob、Alex、Ray 及确定性降级工件；
- `app/api/runs/[id]/step/route.ts`：阶段编排、断点、审计和恢复；
- `lib/quality.ts`：通用质量门和中文打字专项契约；
- `components/workbench.tsx`：尝试状态、失败原因和 `recovered` 展示。

## 5. 面试时可以这样回答

> Token Budget、单次 max_tokens、模型上下文窗口和云函数超时是四个不同的限制。生产系统不能把它们设成无限，否则 Provider 抖动或协议错误会变成无限重试和无限账单。这次我们先从审计记录确认只使用 15,060/180,000 Tokens，再发现 GPT 被错误地按 Chat Completions 协议调用，同时存在 Bob JSON 不可解析和流缺终止事件。修复分三层：按模型选择正确端点；把“传输是否完整”和“工件是否完整”分开，明确 length 截断仍拒绝，结构完整则标记 recovered；规划 Agent 可落到显式审计的确定性工件，但 Alex 真实代码和最终质量门不能跳过。这样系统不会用无限重试掩盖协议错误，也不会用假 Demo 冒充成功。

## 6. 仍然需要承认的边界

这个修复提高的是故障恢复能力，不会把模型变成百分之百可靠：

- Alex 如果真的只生成半个 JavaScript 文件，仍然必须重试；
- Provider 完全不可用或 Key 无效时，无法凭空生成新代码；
- 过大的单文件需求仍需继续拆文件或交给外部长任务 Runner；
- 固定 Eval 全通过不能证明任意自然语言 Prompt 的成功率。
