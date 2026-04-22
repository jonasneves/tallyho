"""Evaluation logic. Loads the eval dataset, runs the agent, and writes scores.json."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).parent.parent
EVAL_DATA = ROOT / "data" / "eval"
SCORES_OUT = ROOT / "results" / "eval" / "scores.json"


def run_eval() -> dict:
    """Run the full evaluation and return scores."""
    raise NotImplementedError


def main() -> None:
    scores = run_eval()
    SCORES_OUT.parent.mkdir(parents=True, exist_ok=True)
    SCORES_OUT.write_text(json.dumps(scores, indent=2))
    print(f"Written → {SCORES_OUT}")
    print(json.dumps(scores, indent=2))


if __name__ == "__main__":
    main()
