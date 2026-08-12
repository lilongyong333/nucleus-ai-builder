from __future__ import annotations

import argparse
import sys
from pathlib import Path

from config import Settings, SettingsError
from llm_client import LLMClient
from orchestrator import MultiAgentWorkflow, WorkflowFailed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="不用 LangChain/LangGraph 手写的 Python 多 Agent 教学示例"
    )
    parser.add_argument("prompt", help="例如：做一个支持键盘和触屏的贪吃蛇游戏")
    parser.add_argument(
        "--runs-root",
        type=Path,
        default=Path(__file__).with_name("runs"),
        help="保存 Artifact、审计日志和最终代码的目录",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        settings = Settings.from_env()
    except SettingsError as exc:
        print(f"配置错误：{exc}", file=sys.stderr)
        return 2

    workflow = MultiAgentWorkflow(
        client=LLMClient(settings),
        settings=settings,
        runs_root=args.runs_root,
    )
    try:
        result = workflow.run(args.prompt)
    except WorkflowFailed as exc:
        print(f"生成失败：{exc}", file=sys.stderr)
        print(f"失败证据：{exc.run_dir}", file=sys.stderr)
        return 1

    print("生成完成")
    print(f"Run ID：{result.run_id}")
    print(f"模型调用：{result.model_calls}")
    print(f"修复轮数：{result.repair_count}")
    print(f"最终代码：{result.output_dir}")
    print(f"质量结论：{result.quality['summary']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
