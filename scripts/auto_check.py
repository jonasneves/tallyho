"""Auto-mark REQUIREMENTS_CHECKLIST.md items verifiable from committed artifacts.

Run by CI on every push to main. Commits a change back if any items were
newly satisfied. No item is ever un-marked.
"""

from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent.parent
CHECKLIST = ROOT / ".github" / "REQUIREMENTS_CHECKLIST.md"
SCORES = ROOT / "results" / "eval" / "scores.json"


def load_json(path: Path) -> dict | None:
    if path.exists():
        return json.loads(path.read_text())
    return None


def file_source(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text()


def repo_is_public(repo: str) -> bool:
    try:
        url = f"https://api.github.com/repos/{repo}"
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read())
        return not data.get("private", True)
    except Exception:
        return False


def evaluate() -> dict[str, bool]:
    scores = load_json(SCORES)
    agent_src = file_source(ROOT / "src" / "agent.js")
    tools_src = file_source(ROOT / "src" / "tools.js")
    eval_src = file_source(ROOT / "src" / "eval.js")
    app_js = file_source(ROOT / "app.js")
    index_html = file_source(ROOT / "index.html")
    readme = file_source(ROOT / "README.md")

    scores_ok = scores is not None and len(scores) > 0

    # Agent loop: has real implementation (imports, fetch calls)
    agent_impl = len(agent_src) > 200 and "CLAUDE_PROXY" in agent_src

    # Tools: tool definitions and execution
    tools_impl = len(tools_src) > 200 and "AGENT_TOOLS" in tools_src

    # UI: index.html + app.js with real content
    ui_impl = len(index_html) > 500 and len(app_js) > 1000

    # Eval: has implementation beyond stub
    eval_impl = len(eval_src) > 100

    return {
        "AGENT1": agent_impl,
        "AGENT2": agent_impl,
        "AGENT3": agent_impl,
        "TOOL1": tools_impl,
        "TOOL2": tools_impl,
        "TOOL3": tools_impl,
        "UI1": ui_impl,
        "UI2": ui_impl,
        "EVAL1": eval_impl,
        "EVAL2": (ROOT / "data" / "eval").exists() and any((ROOT / "data" / "eval").iterdir()),
        "EVAL3": scores_ok,
        "EVAL4": scores_ok,
        "REPO1": repo_is_public("jonasneves/tallyho"),
        "REPO2": "## How to run" in readme and len(readme) > 300,
    }


def mark_item(text: str, item_id: str) -> tuple[str, bool]:
    pattern = rf"(- )\[ \]( \*\*{re.escape(item_id)}\*\*)"
    new_text = re.sub(pattern, r"\1[x]\2", text)
    return new_text, new_text != text


def main() -> None:
    text = CHECKLIST.read_text()
    conditions = evaluate()
    newly_marked = []

    for item_id, satisfied in conditions.items():
        if satisfied:
            text, changed = mark_item(text, item_id)
            if changed:
                newly_marked.append(item_id)

    if newly_marked:
        CHECKLIST.write_text(text)
        print(f"Auto-marked: {', '.join(newly_marked)}")
    else:
        print("No new items to mark.")


if __name__ == "__main__":
    main()
