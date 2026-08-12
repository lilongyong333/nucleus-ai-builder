from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Generic, Protocol, TypeVar

from config import Settings
from llm_client import ChatResult


T = TypeVar("T")
APP_FILES = ("index.html", "styles.css", "script.js")
FENCE = chr(96) * 3


class AgentProtocolError(RuntimeError):
    pass


class ChatClient(Protocol):
    def chat(
        self,
        *,
        agent: str,
        model: str,
        system: str,
        user: str,
        max_tokens: int,
    ) -> ChatResult:
        ...


@dataclass(frozen=True)
class AgentCall(Generic[T]):
    artifact: T
    result: ChatResult


class ProductAgent:
    name = "Iris"

    def __init__(self, client: ChatClient, settings: Settings):
        self.client = client
        self.settings = settings

    def run(self, prompt: str) -> AgentCall[dict[str, Any]]:
        result = self.client.chat(
            agent=self.name,
            model=self.settings.planner_model,
            max_tokens=4000,
            system=(
                "你是产品经理 Iris。把用户需求转成可验收的软件需求契约。"
                "只返回一个 JSON 对象，不要 Markdown，不要解释。字段必须为："
                "app_name 字符串、summary 字符串、features 字符串数组、"
                "acceptance_criteria 字符串数组、risks 字符串数组。"
            ),
            user=f"用户需求：\n{prompt}",
        )
        artifact = parse_json_object(result.content)
        require_list(artifact, "features")
        require_list(artifact, "acceptance_criteria")
        return AgentCall(artifact=artifact, result=result)


class ArchitectAgent:
    name = "Bob"

    def __init__(self, client: ChatClient, settings: Settings):
        self.client = client
        self.settings = settings

    def run(
        self,
        prompt: str,
        requirements: dict[str, Any],
    ) -> AgentCall[dict[str, Any]]:
        result = self.client.chat(
            agent=self.name,
            model=self.settings.architect_model,
            max_tokens=5000,
            system=(
                "你是架构师 Bob。为原生 HTML/CSS/JavaScript 三文件应用设计实现方案。"
                "只返回一个 JSON 对象，不要 Markdown，不要解释。字段必须为："
                "summary 字符串、state_model 字符串数组、interaction_flow 字符串数组、"
                "file_responsibilities 对象且包含 index.html/styles.css/script.js、"
                "test_plan 字符串数组。HTML 只放结构，CSS 只放样式，JavaScript 只放逻辑。"
            ),
            user=(
                f"原始需求：\n{prompt}\n\n"
                f"Iris 需求契约：\n{json.dumps(requirements, ensure_ascii=False)}"
            ),
        )
        artifact = parse_json_object(result.content)
        responsibilities = artifact.get("file_responsibilities")
        if not isinstance(responsibilities, dict) or any(
            path not in responsibilities for path in APP_FILES
        ):
            raise AgentProtocolError("Bob 没有返回完整的三文件职责。")
        return AgentCall(artifact=artifact, result=result)


class CoderAgent:
    name = "Alex"

    def __init__(self, client: ChatClient, settings: Settings):
        self.client = client
        self.settings = settings

    def build_file(
        self,
        *,
        path: str,
        prompt: str,
        requirements: dict[str, Any],
        architecture: dict[str, Any],
        existing_files: dict[str, str],
    ) -> AgentCall[str]:
        assert_supported_path(path)
        result = self.client.chat(
            agent=self.name,
            model=self.settings.coder_model,
            max_tokens=12000 if path == "script.js" else 7000,
            system=(
                f"你是实现工程师 Alex。这一次只能生成 {path}。"
                "直接返回该文件的完整原始内容，不要 Markdown 代码围栏、解释或其他文件。"
                "必须实现验收标准，不能用 TODO、伪代码或假按钮。"
            ),
            user=(
                f"原始需求：\n{prompt}\n\n"
                f"Iris 契约：\n{json.dumps(requirements, ensure_ascii=False)}\n\n"
                f"Bob 架构：\n{json.dumps(architecture, ensure_ascii=False)}\n\n"
                f"已经生成的参考文件：\n{format_files(existing_files)}\n\n"
                f"本次最终交付：{path}"
            ),
        )
        return AgentCall(
            artifact=normalize_file_output(path, result.content),
            result=result,
        )

    def repair_file(
        self,
        *,
        path: str,
        prompt: str,
        requirements: dict[str, Any],
        architecture: dict[str, Any],
        files: dict[str, str],
        issues: list[dict[str, Any]],
    ) -> AgentCall[str]:
        assert_supported_path(path)
        result = self.client.chat(
            agent="AlexFixer",
            model=self.settings.coder_model,
            max_tokens=12000 if path == "script.js" else 7000,
            system=(
                f"你是修复工程师 AlexFixer。这一次只能修复并返回 {path} 的完整内容。"
                "只处理有证据的问题，保留正常功能。不要返回 Markdown、解释或其他文件。"
            ),
            user=(
                f"原始需求：\n{prompt}\n\n"
                f"Iris 契约：\n{json.dumps(requirements, ensure_ascii=False)}\n\n"
                f"Bob 架构：\n{json.dumps(architecture, ensure_ascii=False)}\n\n"
                f"质量问题：\n{json.dumps(issues, ensure_ascii=False)}\n\n"
                f"当前全部文件：\n{format_files(files)}\n\n"
                f"本次只返回修复后的 {path}"
            ),
        )
        return AgentCall(
            artifact=normalize_file_output(path, result.content),
            result=result,
        )


class ReviewerAgent:
    name = "Ray"

    def __init__(self, client: ChatClient, settings: Settings):
        self.client = client
        self.settings = settings

    def run(
        self,
        *,
        prompt: str,
        requirements: dict[str, Any],
        architecture: dict[str, Any],
        files: dict[str, str],
        deterministic_report: dict[str, Any],
    ) -> AgentCall[dict[str, Any]]:
        result = self.client.chat(
            agent=self.name,
            model=self.settings.reviewer_model,
            max_tokens=5000,
            system=(
                "你是只读代码审查员 Ray。你不能修改代码，只能给出审查结论。"
                "根据需求、架构、确定性检查和完整代码逐项找证据。"
                "只返回一个 JSON 对象，不要 Markdown。字段必须为："
                "passed 布尔值、summary 字符串、issues 数组；"
                "每个 issue 包含 severity(error 或 warning)、"
                "file(index.html/styles.css/script.js/application)、detail。"
            ),
            user=(
                f"原始需求：\n{prompt}\n\n"
                f"Iris 契约：\n{json.dumps(requirements, ensure_ascii=False)}\n\n"
                f"Bob 架构：\n{json.dumps(architecture, ensure_ascii=False)}\n\n"
                f"确定性检查：\n{json.dumps(deterministic_report, ensure_ascii=False)}\n\n"
                f"待审代码：\n{format_files(files)}"
            ),
        )
        artifact = parse_json_object(result.content)
        if not isinstance(artifact.get("passed"), bool):
            raise AgentProtocolError("Ray 的 passed 必须是布尔值。")
        issues = artifact.get("issues")
        if not isinstance(issues, list):
            raise AgentProtocolError("Ray 的 issues 必须是数组。")
        return AgentCall(artifact=artifact, result=result)


def parse_json_object(text: str) -> dict[str, Any]:
    candidate = text.strip()
    escaped_fence = re.escape(FENCE)
    fenced = re.fullmatch(
        rf"{escaped_fence}(?:json)?\s*\n?([\s\S]*?)\n?{escaped_fence}\s*",
        candidate,
        flags=re.IGNORECASE,
    )
    if fenced:
        candidate = fenced.group(1).strip()

    decoder = json.JSONDecoder()
    for index, char in enumerate(candidate):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(candidate[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise AgentProtocolError(f"模型没有返回可解析 JSON：{text[:200]!r}")


def normalize_file_output(path: str, text: str) -> str:
    candidate = text.strip()
    escaped_fence = re.escape(FENCE)
    fenced = re.fullmatch(
        rf"{escaped_fence}[^\n]*\n([\s\S]*?)\n{escaped_fence}\s*",
        candidate,
    )
    if fenced:
        candidate = fenced.group(1).strip()
    if FENCE in candidate:
        raise AgentProtocolError(f"{path} 包含多余 Markdown 围栏。")
    if len(candidate) < 40:
        raise AgentProtocolError(f"{path} 内容过短，不能作为可用工件。")
    return candidate + "\n"


def format_files(files: dict[str, str]) -> str:
    if not files:
        return "（暂无）"
    return "\n\n".join(
        f"--- {path} ---\n{content}" for path, content in files.items()
    )


def require_list(value: dict[str, Any], key: str) -> None:
    items = value.get(key)
    if not isinstance(items, list) or not items or not all(
        isinstance(item, str) and item.strip() for item in items
    ):
        raise AgentProtocolError(f"{key} 必须是非空字符串数组。")


def assert_supported_path(path: str) -> None:
    if path not in APP_FILES:
        raise AgentProtocolError(f"不允许生成路径：{path}")
