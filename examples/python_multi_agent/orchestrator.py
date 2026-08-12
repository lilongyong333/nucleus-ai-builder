from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agents import (
    APP_FILES,
    ArchitectAgent,
    CoderAgent,
    ProductAgent,
    ReviewerAgent,
)
from config import Settings
from llm_client import ChatResult
from quality import run_deterministic_checks


class WorkflowFailed(RuntimeError):
    def __init__(self, message: str, run_dir: Path):
        super().__init__(message)
        self.run_dir = run_dir


@dataclass(frozen=True)
class WorkflowResult:
    run_id: str
    run_dir: Path
    output_dir: Path
    quality: dict[str, Any]
    model_calls: int
    repair_count: int


class MultiAgentWorkflow:
    """The orchestrator decides who runs next; agents never call each other."""

    def __init__(self, client: Any, settings: Settings, runs_root: Path):
        self.client = client
        self.settings = settings
        self.runs_root = runs_root
        self.product = ProductAgent(client, settings)
        self.architect = ArchitectAgent(client, settings)
        self.coder = CoderAgent(client, settings)
        self.reviewer = ReviewerAgent(client, settings)

    def run(self, prompt: str) -> WorkflowResult:
        clean_prompt = prompt.strip()
        if len(clean_prompt) < 3:
            raise ValueError("需求至少需要 3 个字符。")

        run_id = make_run_id()
        run_dir = self.runs_root / run_id
        artifacts_dir = run_dir / "artifacts"
        output_dir = run_dir / "output"
        artifacts_dir.mkdir(parents=True, exist_ok=False)
        output_dir.mkdir(parents=True, exist_ok=False)
        audit_path = run_dir / "audit.jsonl"
        state_path = run_dir / "state.json"
        state: dict[str, Any] = {
            "run_id": run_id,
            "prompt": clean_prompt,
            "status": "running",
            "stage": "requirements",
            "repair_count": 0,
            "model_calls": 0,
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
            },
            "started_at": now_iso(),
            "completed_at": None,
            "error": None,
        }
        save_json(state_path, state)
        log_event(audit_path, "System", "start", "working", "创建工作流")

        try:
            requirements_call = self.product.run(clean_prompt)
            requirements = requirements_call.artifact
            save_json(artifacts_dir / "requirements.json", requirements)
            self._record_call(
                state,
                state_path,
                audit_path,
                "Iris",
                "requirements",
                requirements_call.result,
            )

            state["stage"] = "architecture"
            save_json(state_path, state)
            architecture_call = self.architect.run(clean_prompt, requirements)
            architecture = architecture_call.artifact
            save_json(artifacts_dir / "architecture.json", architecture)
            self._record_call(
                state,
                state_path,
                audit_path,
                "Bob",
                "architecture",
                architecture_call.result,
            )

            files: dict[str, str] = {}
            for path in APP_FILES:
                state["stage"] = f"implementation:{path}"
                save_json(state_path, state)
                code_call = self.coder.build_file(
                    path=path,
                    prompt=clean_prompt,
                    requirements=requirements,
                    architecture=architecture,
                    existing_files=files,
                )
                files[path] = code_call.artifact
                write_text(artifacts_dir / path, code_call.artifact)
                self._record_call(
                    state,
                    state_path,
                    audit_path,
                    "Alex",
                    f"implementation:{path}",
                    code_call.result,
                )

            final_quality: dict[str, Any] | None = None
            for review_round in range(self.settings.max_repair_rounds + 1):
                state["stage"] = "quality"
                save_json(state_path, state)
                deterministic = run_deterministic_checks(files)
                review_call = self.reviewer.run(
                    prompt=clean_prompt,
                    requirements=requirements,
                    architecture=architecture,
                    files=files,
                    deterministic_report=deterministic,
                )
                self._record_call(
                    state,
                    state_path,
                    audit_path,
                    "Ray",
                    f"quality:{review_round}",
                    review_call.result,
                )
                model_review = normalize_review(review_call.artifact)
                all_issues = [
                    *deterministic["errors"],
                    *model_review["issues"],
                ]
                blocking = [
                    issue
                    for issue in all_issues
                    if issue.get("severity") == "error"
                ]
                passed = (
                    deterministic["passed"]
                    and model_review["passed"]
                    and not blocking
                )
                final_quality = {
                    "passed": passed,
                    "round": review_round,
                    "summary": model_review["summary"],
                    "deterministic": deterministic,
                    "model_review": model_review,
                    "issues": all_issues,
                }
                save_json(
                    artifacts_dir / f"quality-{review_round}.json",
                    final_quality,
                )

                if passed:
                    log_event(
                        audit_path,
                        "Ray",
                        "quality-gate",
                        "done",
                        "确定性检查和独立模型审查同时通过",
                    )
                    break

                if review_round >= self.settings.max_repair_rounds:
                    raise WorkflowFailed(
                        f"经过 {state['repair_count']} 轮修复后质量门仍未通过。",
                        run_dir,
                    )

                state["stage"] = "repair"
                state["repair_count"] += 1
                save_json(state_path, state)
                targets = repair_targets(all_issues)
                log_event(
                    audit_path,
                    "System",
                    "repair-route",
                    "working",
                    f"把 {', '.join(targets)} 交回 AlexFixer",
                )
                for path in targets:
                    repair_call = self.coder.repair_file(
                        path=path,
                        prompt=clean_prompt,
                        requirements=requirements,
                        architecture=architecture,
                        files=files,
                        issues=all_issues,
                    )
                    files[path] = repair_call.artifact
                    write_text(artifacts_dir / path, repair_call.artifact)
                    self._record_call(
                        state,
                        state_path,
                        audit_path,
                        "AlexFixer",
                        f"repair:{path}",
                        repair_call.result,
                    )

            if final_quality is None or not final_quality["passed"]:
                raise WorkflowFailed("工作流没有形成可发布质量结论。", run_dir)

            state["stage"] = "finalize"
            save_json(state_path, state)
            for path, content in files.items():
                write_text(output_dir / path, content)
            save_json(output_dir / "quality.json", final_quality)

            state["stage"] = "completed"
            state["status"] = "completed"
            state["completed_at"] = now_iso()
            save_json(state_path, state)
            log_event(
                audit_path,
                "System",
                "finalize",
                "done",
                "最终代码和质量证据已经保存",
            )
            return WorkflowResult(
                run_id=run_id,
                run_dir=run_dir,
                output_dir=output_dir,
                quality=final_quality,
                model_calls=state["model_calls"],
                repair_count=state["repair_count"],
            )
        except Exception as exc:
            state["status"] = "failed"
            state["stage"] = "failed"
            state["error"] = str(exc)
            state["completed_at"] = now_iso()
            save_json(state_path, state)
            log_event(audit_path, "System", "failed", "error", str(exc))
            if isinstance(exc, WorkflowFailed):
                raise
            raise WorkflowFailed(str(exc), run_dir) from exc

    def _record_call(
        self,
        state: dict[str, Any],
        state_path: Path,
        audit_path: Path,
        agent: str,
        phase: str,
        result: ChatResult,
    ) -> None:
        state["model_calls"] += 1
        for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
            state["usage"][key] += int(result.usage.get(key, 0))
        save_json(state_path, state)
        log_event(
            audit_path,
            agent,
            phase,
            "done",
            f"{result.model} · {result.duration_ms} ms",
            {
                "model": result.model,
                "duration_ms": result.duration_ms,
                "usage": result.usage,
            },
        )


def normalize_review(value: dict[str, Any]) -> dict[str, Any]:
    normalized_issues: list[dict[str, str]] = []
    for raw in value.get("issues", []):
        if not isinstance(raw, dict):
            continue
        severity = "error" if raw.get("severity") == "error" else "warning"
        file = str(raw.get("file") or "application")
        if file not in {*APP_FILES, "application"}:
            file = "application"
        detail = str(raw.get("detail") or "审查员未提供细节")[:1000]
        normalized_issues.append(
            {"severity": severity, "file": file, "detail": detail}
        )
    return {
        "passed": value.get("passed") is True,
        "summary": str(value.get("summary") or "Ray 已完成审查")[:1000],
        "issues": normalized_issues,
    }


def repair_targets(issues: list[dict[str, Any]]) -> list[str]:
    targets = {
        str(issue.get("file"))
        for issue in issues
        if issue.get("severity") == "error"
        and str(issue.get("file")) in APP_FILES
    }
    if any(
        issue.get("severity") == "error"
        and issue.get("file") == "application"
        for issue in issues
    ):
        return list(APP_FILES)
    return [path for path in APP_FILES if path in targets] or list(APP_FILES)


def make_run_id() -> str:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return f"{stamp}-{uuid.uuid4().hex[:8]}"


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def save_json(path: Path, value: Any) -> None:
    text = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    write_text(path, text)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def log_event(
    path: Path,
    agent: str,
    phase: str,
    status: str,
    detail: str,
    extra: dict[str, Any] | None = None,
) -> None:
    event = {
        "timestamp": now_iso(),
        "agent": agent,
        "phase": phase,
        "status": status,
        "detail": detail,
        **(extra or {}),
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")
