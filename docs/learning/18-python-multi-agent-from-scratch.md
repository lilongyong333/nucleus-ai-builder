# 18. 用 Python 从零手撕多 Agent

本章配套代码：
[`examples/python_multi_agent`](../../examples/python_multi_agent/README.md)。

## 1. 先记住最小公式

```text
Agent = 模型 + System Prompt + 独立上下文 + 输出协议 + 权限
Workflow = State + Agent 节点 + 跳转规则 + 终止条件
```

多 Agent 的关键不是创建四个类，也不是显示四个头像，而是每个角色都形成
独立模型调用，并通过可检查的工件交接。

## 2. 最小执行链

```text
用户需求
  -> Iris 生成 requirements.json
  -> Bob 读取 requirements.json，生成 architecture.json
  -> Alex 读取两份工件，分别生成三个代码文件
  -> 本地代码固定执行确定性检查
  -> Ray 只读审查
  -> AlexFixer 根据问题修改
  -> Ray 重新审查
```

这里 Agent 不直接互相调用。Orchestrator 是唯一的流程控制者。这样做能
限制调用次数、保存检查点，并避免某个 Agent 自己无限创建其他 Agent。

## 3. API Key、模型和 Agent 不要混为一谈

一次 OpenAI-compatible 请求的核心是：

```python
POST /chat/completions
Authorization: Bearer <server-side-key>

{
    "model": "某个模型名",
    "messages": [
        {"role": "system", "content": "岗位说明"},
        {"role": "user", "content": "本轮工件"}
    ]
}
```

一枚网关 Key 可以授权调用多个模型。Agent 的身份来自 Prompt、上下文、
输出协议和权限；`model` 字段用于选模型，Key 不用于区分角色。

## 4. 代码阅读顺序

### 第一步：`config.py`

只负责读配置。真实 Key 只存在本地 `.env`，不能出现在代码、文档、
浏览器或 Git 中。

### 第二步：`llm_client.py`

`LLMClient.chat()` 是唯一网络出口。它统一完成：

- Bearer 认证；
- 模型选择；
- 超时；
- 对 429/5xx 的有限重试；
- OpenAI-compatible 响应解析；
- Token Usage 归一化；
- 总调用次数上限。

如果每个 Agent 都自己拼 HTTP 请求，后续很难统一轮换 Key、记录成本和做
故障切换。

### 第三步：`agents.py`

每个 Agent 只做三件事：

1. 构造本岗位的 System Prompt；
2. 只接收必要工件；
3. 校验返回协议。

Ray 没有返回代码的方法，AlexFixer 也不负责判断是否通过。这是最小权限和
写审分离。

### 第四步：`quality.py`

确定性规则不应该交给模型猜。本例固定检查：

- 三个文件是否完整；
- 是否残留 Markdown；
- HTML 是否引用 CSS/JavaScript；
- 是否出现内联样式；
- CSS 花括号是否配对；
- Node.js 可用时执行 `node --check`；
- 是否存在 TODO 或假实现。

模型审查负责语义，程序规则负责硬事实。

### 第五步：`orchestrator.py`

这是整套系统最重要的文件。它决定：

```python
requirements = iris.run(prompt)
architecture = bob.run(prompt, requirements)
files = alex.build(...)
quality = ray.run(...)

if quality_passed:
    finalize()
else:
    alex_fixer.repair()
    ray.run_again()
```

这就是不用 LangGraph 手写出来的 State Machine。

## 5. 为什么 Reviewer 仍可能幻觉

独立调用只降低上下文污染，不保证正确。如果 Writer 和 Reviewer 使用同一
底层模型，它们可能有相同盲点。生产方案还需要：

- Reviewer 使用不同模型或不同提供商；
- Reviewer 只读；
- 不把 Writer 的自我评价喂给 Reviewer；
- 编译、单测和浏览器点击作为硬证据；
- 修复次数、时间和 Token 有上限；
- 最终高风险动作需要人工批准。

## 6. 与 LangChain、LangGraph、Claude Code 的关系

| 方案 | 谁决定下一步 | 本例对应关系 |
|---|---|---|
| LangChain Chain | 代码预先串联 | 每个 Agent 的 Prompt -> Model -> Parser |
| LangGraph | 图和条件边 | Orchestrator + state.json + Artifact |
| Claude Code Agent Loop | 模型根据 tool result 动态选工具 | 本例尚未实现 |
| Agent Team | Lead、独立会话、任务列表和消息 | 本例是单进程顺序协作 |

最适合产品化的方向不是二选一，而是外层固定图、内层工具循环：

```text
外层负责安全、审计、恢复和成本
内层负责读取、编辑、运行测试和动态纠错
```

## 7. 你应该亲手完成的三个练习

### 练习一：新增 SecurityReviewer

让它只接收代码和确定性报告，只输出安全问题，不允许返回代码。总调度器
要求 Ray 和 SecurityReviewer 都通过。

### 练习二：不同模型路由

把环境变量改成：

```dotenv
PLANNER_MODEL=general-model
CODER_MODEL=code-model
REVIEWER_MODEL=another-model
```

在 `audit.jsonl` 核对每次调用实际使用的模型。注意：换模型不等于换
API Key。

### 练习三：增加一个只读工具循环

先只允许 Reviewer 调用 `read_file` 和 `run_tests`。解析模型返回的
tool call，程序校验白名单后执行，再把 tool result 喂回模型。不要一开始就
开放任意 Shell。

## 8. 面试可直接回答

“我会先手写一个 Orchestrator，维护当前阶段、Artifact、调用预算和修复次数。
Iris、Bob、Alex、Ray 每个角色都是独立 API 请求，使用不同 System Prompt、
最小上下文和结构化输出。Alex 负责写，Ray 只输出问题，问题再路由给
AlexFixer，最后由新的 Ray 调用复审。发布条件不是 Reviewer 自评，而是
确定性检查和模型审查同时通过。这个版本相当于不用 LangGraph 手写状态机；
继续扩展时，我会保留外层固定图，再在 Alex 节点内部加入受权限约束的
Read/Edit/Test 工具循环。”
