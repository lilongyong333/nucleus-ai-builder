from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from config import Settings


class CloudAPIError(RuntimeError):
    pass


class ModelBudgetError(RuntimeError):
    pass


@dataclass(frozen=True)
class ChatResult:
    agent: str
    model: str
    content: str
    usage: dict[str, int]
    duration_ms: int


class LLMClient:
    """Minimal OpenAI-compatible /chat/completions client."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.calls = 0

    def chat(
        self,
        *,
        agent: str,
        model: str,
        system: str,
        user: str,
        max_tokens: int,
    ) -> ChatResult:
        if self.calls >= self.settings.max_model_calls:
            raise ModelBudgetError(
                f"模型调用达到上限 {self.settings.max_model_calls}，工作流安全停止。"
            )

        self.calls += 1
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": max_tokens,
            "stream": False,
        }
        started = time.perf_counter()
        data = self._request_with_retry(payload)
        duration_ms = round((time.perf_counter() - started) * 1000)

        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise CloudAPIError(
                f"{agent} 收到无法识别的响应结构：{str(data)[:300]}"
            ) from exc

        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            reasoning = message.get("reasoning_content")
            fence = chr(96) * 3
            if isinstance(reasoning, str) and (
                fence in reasoning or reasoning.lstrip().startswith("{")
            ):
                content = reasoning
        if not isinstance(content, str) or not content.strip():
            raise CloudAPIError(f"{agent} 收到空响应。")

        return ChatResult(
            agent=agent,
            model=str(data.get("model") or model),
            content=content.strip(),
            usage=normalize_usage(data.get("usage")),
            duration_ms=duration_ms,
        )

    def _request_with_retry(self, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.settings.api_base_url}/chat/completions"
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        retryable_statuses = {408, 429, 500, 502, 503, 504}
        last_error = "未知网络错误"

        for attempt in range(self.settings.max_retries + 1):
            request = Request(
                url,
                data=encoded,
                method="POST",
                headers={
                    "Authorization": f"Bearer {self.settings.api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            )
            try:
                with urlopen(
                    request,
                    timeout=self.settings.request_timeout_seconds,
                ) as response:
                    body = response.read().decode("utf-8")
                    parsed = json.loads(body)
                    if not isinstance(parsed, dict):
                        raise CloudAPIError("云端 API 返回的不是 JSON 对象。")
                    return parsed
            except HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")[:500]
                last_error = f"HTTP {exc.code}: {detail}"
                if exc.code not in retryable_statuses:
                    raise CloudAPIError(last_error) from exc
            except (URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = str(exc)

            if attempt < self.settings.max_retries:
                time.sleep(min(2**attempt, 4))

        raise CloudAPIError(
            f"云端 API 在 {self.settings.max_retries + 1} 次尝试后仍失败："
            f"{last_error}"
        )


def normalize_usage(raw: Any) -> dict[str, int]:
    usage = raw if isinstance(raw, dict) else {}
    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    total = int(usage.get("total_tokens") or prompt + completion)
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
    }
