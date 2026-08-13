from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


EXAMPLE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXAMPLE_ROOT))

from config import Settings
from llm_client import LLMClient


class FakeResponse:
    def __init__(self, payload: dict[str, object]):
        self.body = json.dumps(payload).encode("utf-8")

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


class LLMClientTests(unittest.TestCase):
    @patch("llm_client.urlopen")
    def test_key_authenticates_but_model_field_routes(self, mocked_urlopen: object) -> None:
        mocked_urlopen.return_value = FakeResponse(
            {
                "model": "review-model",
                "choices": [{"message": {"content": "审查完成"}}],
                "usage": {
                    "prompt_tokens": 3,
                    "completion_tokens": 2,
                    "total_tokens": 5,
                },
            }
        )
        settings = Settings(
            api_base_url="https://gateway.example/v1",
            api_key="server-side-test-key",
            planner_model="plan-model",
            architect_model="arch-model",
            coder_model="code-model",
            reviewer_model="review-model",
        )
        result = LLMClient(settings).chat(
            agent="Ray",
            model=settings.reviewer_model,
            system="只读审查",
            user="检查代码",
            max_tokens=500,
        )

        request = mocked_urlopen.call_args.args[0]
        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(request.full_url, "https://gateway.example/v1/chat/completions")
        self.assertEqual(
            request.get_header("Authorization"),
            "Bearer server-side-test-key",
        )
        self.assertEqual(body["model"], "review-model")
        self.assertNotIn("server-side-test-key", json.dumps(body))
        self.assertEqual(result.content, "审查完成")
        self.assertEqual(result.usage["total_tokens"], 5)


if __name__ == "__main__":
    unittest.main()
