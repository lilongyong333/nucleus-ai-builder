# Python 手撕多 Agent：不依赖 LangChain / LangGraph

这是一个可以单独运行的教学项目。它只使用 Python 标准库，通过
OpenAI-compatible 的 `/chat/completions` 云端接口实现：

```text
用户需求
  -> Iris：需求 JSON
  -> Bob：架构 JSON
  -> Alex：分别生成 HTML / CSS / JavaScript
  -> 本地确定性检查
  -> Ray：只读审查 JSON
       -> 通过：保存最终代码
       -> 失败：AlexFixer 修复 -> Ray 再审
```

它的目的不是复刻完整 Claude Code，而是先让你亲手理解多 Agent 最重要的
五件事：独立调用、上下文隔离、工件交接、条件路由和有限循环。

## 1. 文件分别做什么

| 文件 | 大白话职责 |
|---|---|
| `config.py` | 从 `.env` 读取网关、Key、角色模型和预算 |
| `llm_client.py` | 真正发送 HTTP 请求；Key 在 Header，模型名在 JSON Body |
| `agents.py` | 定义 Iris、Bob、Alex、AlexFixer、Ray 的岗位和输出协议 |
| `quality.py` | 不问模型，直接检查三文件、HTML 引用和 JavaScript 语法 |
| `orchestrator.py` | 总调度器；决定先后顺序、是否修复、何时停止 |
| `main.py` | CLI 入口，把用户的一句话交给工作流 |
| `tests/test_workflow.py` | 用假云端响应验证写审分离和修复闭环，不消耗 Token |

## 2. 准备安全配置

旧 Key 如果曾出现在聊天、截图或 Git 中，先到提供商控制台撤销并新建。

PowerShell：

```powershell
cd C:\Users\Windows\Desktop\demo\nucleus\examples\python_multi_agent
Copy-Item .env.example .env
notepad .env
```

至少填写：

```dotenv
CLOUD_API_KEY=新的服务端Key
CLOUD_DEFAULT_MODEL=网关真实支持的通用模型名
CODER_MODEL=网关真实支持的代码模型名
REVIEWER_MODEL=网关真实支持的审查模型名
```

同一个网关 Key 可以供多个 Agent 使用。Key 只负责认证和计费；每次请求
Body 里的 `model` 字段才负责切换模型。

不要把 `.env` 提交到 Git。本目录的 `.gitignore` 已排除它，但已经
公开过的 Key 仍必须轮换，删除文件无法让旧 Key 重新安全。

## 3. 先运行无 Token 测试

```powershell
python -m unittest discover -s tests -v
```

测试一验证：

```text
Iris -> Bob -> Alex x 3 -> Ray -> completed
```

测试二故意让 HTML 缺少资源引用，验证：

```text
Ray 只报告问题
  -> Orchestrator 把问题交给 AlexFixer
  -> AlexFixer 只修 index.html
  -> Ray 使用新调用重新审查
  -> completed
```

## 4. 调真实云端 API

```powershell
python main.py "做一个支持键盘和触屏、可以暂停和重新开始的贪吃蛇游戏"
```

完成后会生成：

```text
runs/<run-id>/
├─ state.json
├─ audit.jsonl
├─ artifacts/
│  ├─ requirements.json
│  ├─ architecture.json
│  ├─ index.html
│  ├─ styles.css
│  ├─ script.js
│  └─ quality-0.json
└─ output/
   ├─ index.html
   ├─ styles.css
   ├─ script.js
   └─ quality.json
```

双击或用浏览器打开 `output/index.html` 即可检查生成结果。

## 5. 一次模型调用究竟是什么

`llm_client.py` 发送的核心数据相当于：

```python
payload = {
    "model": model,
    "messages": [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": task_context},
    ],
    "max_tokens": max_tokens,
    "stream": False,
}
```

HTTP Header 是：

```python
headers = {
    "Authorization": f"Bearer {api_key}",
    "Content-Type": "application/json",
}
```

所以角色不是 API Key：

```text
API Key       = 公司门禁卡
model         = 选择哪颗大脑
system prompt = 岗位说明书
user context  = 这一次拿到的工单
output schema = 必须交回什么格式
```

## 6. 为什么这不是四个名字演戏

四个角色分别执行 `client.chat(...)`，每次都有新的 messages 数组。Bob
读取 Iris 保存的 JSON，而不是共享 Iris 的整段聊天历史；Ray 读取最终代码和
确定性结果，而不是读取 Alex 的自我评价。

Writer/Reviewer 也被刻意分开：

```text
Alex       能返回代码
Ray        只能返回 passed / issues
AlexFixer  根据 issues 返回修复代码
Ray        再用一次独立调用验收
```

最终 `passed` 不是 Ray 一句话决定的，而是：

```python
passed = (
    deterministic_checks_passed
    and ray_review_passed
    and no_blocking_issues
)
```

## 7. Orchestrator 才是真正的队长

Agent 不直接调用另一个 Agent。`orchestrator.py` 负责：

1. 先调用 Iris；
2. 保存 `requirements.json`；
3. 把这个工件交给 Bob；
4. 再把需求和架构交给 Alex；
5. 代码完成后固定执行质量检查；
6. 根据质量结果决定结束还是修复；
7. 超过修复次数或调用预算后安全停止。

这等价于手写一个轻量 LangGraph：

```text
State      = state.json + Python 变量
Node       = 每个 Agent 的 run/build_file/repair_file
Edge       = Orchestrator 中固定的调用顺序
Condition  = passed 为真或假
Checkpoint = artifacts 目录
Audit      = audit.jsonl
```

## 8. 它和 Claude Code 工具循环还差什么

这个示例是“固定多 Agent 工作流”，还不是模型自主选工具的循环。请求 Body
中没有 `tools`，代码也没有处理 `tool_call/tool_result`。

Claude Code 风格的下一层会在 Alex 内部增加：

```python
for turn in range(max_turns):
    response = model(messages, tools=tool_schemas)
    if not response.tool_calls:
        return response.text
    for call in response.tool_calls:
        result = execute_allowed_tool(call)
        messages.append(tool_result(call.id, result))
```

推荐的正式架构是：

```text
外层固定工作流：Iris -> Bob -> Alex -> Ray
内层动态工具循环：Alex -> Read/Edit/Test -> Alex
硬门禁：编译器、测试、浏览器证据
```

先把本例完全看懂，再加 Tool Loop。否则很容易把“循环读取 HTTP 数据流”
误认为“Agent 在自主选择工具”。

## 9. 建议手敲顺序

不要一次照抄全部文件。按这个顺序自己重新建一个空目录：

1. 只写 `llm_client.py`，让一次 Prompt 能获得云端回复；
2. 写两个函数 `writer()` 和 `reviewer()`，确认产生两次 API 调用；
3. 把返回内容保存为 `code.txt` 和 `review.json`；
4. 增加 `if review["passed"]` 条件；
5. 增加最多两轮修复；
6. 最后才拆出 Iris、Bob 和三个文件；
7. 再补本地测试、审计和调用预算。

做到第 5 步，你已经可以在白板上手写出真正的 Writer/Reviewer 多 Agent
闭环；后面的内容是在把它产品化。
