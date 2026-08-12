from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


EXAMPLE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXAMPLE_ROOT))

from config import Settings
from llm_client import ChatResult
from orchestrator import MultiAgentWorkflow


VALID_REQUIREMENTS = json.dumps(
    {
        "app_name": "任务板",
        "summary": "一个可添加任务的应用",
        "features": ["添加任务", "完成任务"],
        "acceptance_criteria": ["按钮可点击", "状态可切换"],
        "risks": ["输入为空"],
    },
    ensure_ascii=False,
)
VALID_ARCHITECTURE = json.dumps(
    {
        "summary": "三文件原生应用",
        "state_model": ["tasks"],
        "interaction_flow": ["输入", "添加", "完成"],
        "file_responsibilities": {
            "index.html": "页面结构",
            "styles.css": "视觉样式",
            "script.js": "交互逻辑",
        },
        "test_plan": ["添加任务", "切换状态"],
    },
    ensure_ascii=False,
)
GOOD_HTML = """<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"></head>
<body><main><input id="task"><button id="add">添加</button><ul id="list"></ul></main>
<script src="script.js"></script></body></html>
"""
BAD_HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"></head>
<body><main><button id="add">添加</button></main></body></html>
"""
GOOD_CSS = """body { font-family: sans-serif; margin: 0; }
main { max-width: 40rem; margin: auto; padding: 2rem; }
button:focus-visible { outline: 3px solid blue; }
"""
GOOD_JS = """const button = document.getElementById("add");
const input = document.getElementById("task");
const list = document.getElementById("list");
button?.addEventListener("click", () => {
  const item = document.createElement("li");
  item.textContent = input?.value || "新任务";
  list?.appendChild(item);
});
"""
PASS_REVIEW = json.dumps(
    {"passed": True, "summary": "验收通过", "issues": []},
    ensure_ascii=False,
)
FAIL_REVIEW = json.dumps(
    {
        "passed": False,
        "summary": "HTML 缺少资源引用",
        "issues": [
            {
                "severity": "error",
                "file": "index.html",
                "detail": "缺少 styles.css 和 script.js 引用",
            }
        ],
    },
    ensure_ascii=False,
)


class ScriptedClient:
    def __init__(self, responses: list[str]):
        self.responses = list(responses)
        self.calls: list[dict[str, object]] = []

    def chat(self, **kwargs: object) -> ChatResult:
        if not self.responses:
            raise AssertionError("测试响应已经用完")
        self.calls.append(kwargs)
        content = self.responses.pop(0)
        return ChatResult(
            agent=str(kwargs["agent"]),
            model=str(kwargs["model"]),
            content=content,
            usage={
                "prompt_tokens": 10,
                "completion_tokens": 20,
                "total_tokens": 30,
            },
            duration_ms=5,
        )


def settings(max_repairs: int = 2) -> Settings:
    return Settings(
        api_base_url="https://example.invalid/v1",
        api_key="test-only-key",
        planner_model="planner-model",
        architect_model="architect-model",
        coder_model="coder-model",
        reviewer_model="reviewer-model",
        max_model_calls=20,
        max_repair_rounds=max_repairs,
    )


class WorkflowTests(unittest.TestCase):
    def test_agents_use_separate_calls_and_models(self) -> None:
        client = ScriptedClient(
            [
                VALID_REQUIREMENTS,
                VALID_ARCHITECTURE,
                GOOD_HTML,
                GOOD_CSS,
                GOOD_JS,
                PASS_REVIEW,
            ]
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            workflow = MultiAgentWorkflow(
                client,
                settings(),
                Path(temp_dir),
            )
            result = workflow.run("做一个可以添加和完成任务的任务板")

            self.assertTrue(result.quality["passed"])
            self.assertEqual(result.repair_count, 0)
            self.assertEqual(result.model_calls, 6)
            self.assertTrue((result.output_dir / "index.html").exists())
            self.assertTrue((result.run_dir / "audit.jsonl").exists())
            self.assertNotIn(
                "test-only-key",
                (result.run_dir / "audit.jsonl").read_text(encoding="utf-8"),
            )
            self.assertEqual(
                [call["agent"] for call in client.calls],
                ["Iris", "Bob", "Alex", "Alex", "Alex", "Ray"],
            )
            self.assertEqual(client.calls[2]["model"], "coder-model")
            self.assertEqual(client.calls[-1]["model"], "reviewer-model")

    def test_reviewer_reports_and_coder_repairs(self) -> None:
        client = ScriptedClient(
            [
                VALID_REQUIREMENTS,
                VALID_ARCHITECTURE,
                BAD_HTML,
                GOOD_CSS,
                GOOD_JS,
                FAIL_REVIEW,
                GOOD_HTML,
                PASS_REVIEW,
            ]
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            workflow = MultiAgentWorkflow(
                client,
                settings(),
                Path(temp_dir),
            )
            result = workflow.run("做一个可以添加和完成任务的任务板")

            self.assertTrue(result.quality["passed"])
            self.assertEqual(result.repair_count, 1)
            self.assertEqual(result.model_calls, 8)
            self.assertEqual(client.calls[5]["agent"], "Ray")
            self.assertEqual(client.calls[6]["agent"], "AlexFixer")
            self.assertEqual(client.calls[7]["agent"], "Ray")
            state = json.loads(
                (result.run_dir / "state.json").read_text(encoding="utf-8")
            )
            self.assertEqual(state["status"], "completed")
            self.assertEqual(state["usage"]["total_tokens"], 240)


if __name__ == "__main__":
    unittest.main()
