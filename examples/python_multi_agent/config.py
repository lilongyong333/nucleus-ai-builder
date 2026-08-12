from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


class SettingsError(RuntimeError):
    pass


def load_env_file(path: Path) -> None:
    """A tiny .env loader so this teaching example needs no third-party package."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


def env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise SettingsError(f"{name} 必须是整数，当前值为 {raw!r}") from exc
    return max(minimum, min(maximum, value))


def optional_model(name: str, fallback: str) -> str:
    value = os.getenv(name, "").strip()
    return value or fallback


def is_placeholder(value: str) -> bool:
    lowered = value.lower()
    return any(marker in lowered for marker in ("replace_with", "your_", "填入"))


@dataclass(frozen=True)
class Settings:
    api_base_url: str
    api_key: str
    planner_model: str
    architect_model: str
    coder_model: str
    reviewer_model: str
    request_timeout_seconds: int = 90
    max_retries: int = 2
    max_model_calls: int = 20
    max_repair_rounds: int = 2

    @classmethod
    def from_env(cls) -> "Settings":
        load_env_file(Path(__file__).with_name(".env"))
        api_base_url = os.getenv(
            "CLOUD_API_BASE_URL",
            "https://opencode.ai/zen/go/v1",
        ).strip().rstrip("/")
        api_key = os.getenv("CLOUD_API_KEY", "").strip()
        default_model = os.getenv("CLOUD_DEFAULT_MODEL", "").strip()

        if not api_key or is_placeholder(api_key):
            raise SettingsError(
                "缺少可用的 CLOUD_API_KEY。请复制 .env.example 为 .env，"
                "并填写已经轮换的新 Key。"
            )
        if not default_model or is_placeholder(default_model):
            raise SettingsError("缺少 CLOUD_DEFAULT_MODEL，请填写网关真实支持的模型名。")

        resolved_models = {
            "planner_model": optional_model("PLANNER_MODEL", default_model),
            "architect_model": optional_model("ARCHITECT_MODEL", default_model),
            "coder_model": optional_model("CODER_MODEL", default_model),
            "reviewer_model": optional_model("REVIEWER_MODEL", default_model),
        }
        invalid_names = [
            name for name, value in resolved_models.items() if is_placeholder(value)
        ]
        if invalid_names:
            raise SettingsError(
                f"{', '.join(invalid_names)} 仍是占位符，请填写真实模型名或留空继承默认模型。"
            )

        return cls(
            api_base_url=api_base_url,
            api_key=api_key,
            **resolved_models,
            request_timeout_seconds=env_int(
                "CLOUD_REQUEST_TIMEOUT_SECONDS", 90, 10, 300
            ),
            max_retries=env_int("CLOUD_MAX_RETRIES", 2, 0, 5),
            max_model_calls=env_int("WORKFLOW_MAX_MODEL_CALLS", 20, 4, 50),
            max_repair_rounds=env_int(
                "WORKFLOW_MAX_REPAIR_ROUNDS", 2, 0, 5
            ),
        )
