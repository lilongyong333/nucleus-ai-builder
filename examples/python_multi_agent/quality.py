from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any


APP_FILES = ("index.html", "styles.css", "script.js")


def run_deterministic_checks(files: dict[str, str]) -> dict[str, Any]:
    """Checks that code, not another model, can decide deterministically."""
    checks: list[dict[str, str]] = []

    def add(
        check_id: str,
        passed: bool,
        file: str,
        detail: str,
        severity: str = "error",
    ) -> None:
        checks.append(
            {
                "id": check_id,
                "passed": passed,
                "severity": "pass" if passed else severity,
                "file": file,
                "detail": detail,
            }
        )

    for path in APP_FILES:
        content = files.get(path, "")
        add(
            f"{path}:exists",
            len(content.strip()) >= 40,
            path,
            f"{path} 必须存在且不能是空壳。",
        )
        add(
            f"{path}:no-markdown",
            chr(96) * 3 not in content,
            path,
            f"{path} 不能残留 Markdown 代码围栏。",
        )

    html = files.get("index.html", "")
    html_lower = html.lower()
    add(
        "html:document",
        all(tag in html_lower for tag in ("<!doctype", "<html", "<body", "</body>")),
        "index.html",
        "HTML 必须包含完整文档结构。",
    )
    add(
        "html:stylesheet",
        bool(
            re.search(
                r"<link[^>]+href=[\"'][^\"']*styles\.css[\"']",
                html,
                flags=re.IGNORECASE,
            )
        ),
        "index.html",
        "HTML 必须引用 styles.css。",
    )
    add(
        "html:script",
        bool(
            re.search(
                r"<script[^>]+src=[\"'][^\"']*script\.js[\"'][^>]*>\s*</script>",
                html,
                flags=re.IGNORECASE,
            )
        ),
        "index.html",
        "HTML 必须通过 src 引用 script.js。",
    )
    add(
        "html:no-inline-style",
        "<style" not in html_lower and " style=" not in html_lower,
        "index.html",
        "样式应放在 styles.css，不应内联。",
    )

    css = files.get("styles.css", "")
    add(
        "css:balanced-braces",
        css.count("{") == css.count("}") and css.count("{") > 0,
        "styles.css",
        "CSS 花括号必须配对。",
    )

    js = files.get("script.js", "")
    placeholder = bool(
        re.search(
            r"\bTODO\b|coming\s+soon|待实现|伪代码",
            "\n".join(files.values()),
            flags=re.IGNORECASE,
        )
    )
    add(
        "app:no-placeholder",
        not placeholder,
        "application",
        "交付代码不能包含 TODO、Coming soon、待实现或伪代码。",
    )

    node = shutil.which("node")
    if node and js.strip():
        with tempfile.TemporaryDirectory(prefix="multi-agent-js-") as temp_dir:
            script_path = Path(temp_dir) / "script.js"
            script_path.write_text(js, encoding="utf-8")
            process = subprocess.run(
                [node, "--check", str(script_path)],
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            detail = (
                "JavaScript 语法检查通过。"
                if process.returncode == 0
                else (process.stderr or process.stdout)[-500:]
            )
            add(
                "javascript:syntax",
                process.returncode == 0,
                "script.js",
                detail,
            )
    else:
        add(
            "javascript:syntax",
            True,
            "script.js",
            "当前机器没有 Node.js，跳过语法执行并保留警告。",
            severity="warning",
        )
        checks[-1]["severity"] = "warning"

    errors = [
        {
            "severity": "error",
            "file": check["file"],
            "detail": check["detail"],
        }
        for check in checks
        if not check["passed"] and check["severity"] == "error"
    ]
    warnings = [
        {
            "severity": "warning",
            "file": check["file"],
            "detail": check["detail"],
        }
        for check in checks
        if check["severity"] == "warning"
    ]
    return {
        "passed": not errors,
        "checks": checks,
        "errors": errors,
        "warnings": warnings,
    }
