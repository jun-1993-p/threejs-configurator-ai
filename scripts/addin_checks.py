"""애드인 점검 파일(data/addin-checks/<업로드 ID>.json)을 세 줄로 읽는다. 녹화 위저드가 부른다.

    .venv/Scripts/python -m scripts.addin_checks data/addin-checks/<업로드 ID>.json

줄마다 파라미터, 어셈블리 좌표, 재계산 실패 샘플이다. 키는 애드인의 _write_checks가 쓴다(docs/recording-guide.md 4-3).
업로드 뒤 다시 되돌린 파라미터가 있으면 종료 코드 RESTORED_AGAIN으로 끝난다. 위저드는 문장이 아니라 종료 코드로 판정한다.
"""

import json
import sys
from pathlib import Path
from typing import Any

RESTORED_ALL = "모두 원래대로"
RESTORED_AGAIN = 3


def _first(items: list[str]) -> str:
    return ": " + "; ".join(items[:3]) if items else ""


def describe(checks: dict[str, Any]) -> list[str]:
    restored = checks["restored"]
    mismatches = checks["proxy_mismatches"]
    failures = checks["recompute_failures"]
    return [
        "업로드 뒤 다시 되돌림: " + ", ".join(restored) if restored else RESTORED_ALL,
        f"모서리 {checks['proxy_edges']}개(옮긴 오커런스 {checks['moved_occurrences']}개) 중"
        f" 어긋남 {len(mismatches)}개{_first(mismatches)}",
        f"{len(failures)}개{_first(failures)}",
    ]


def main(path: str) -> int:
    checks = json.loads(Path(path).read_text(encoding="utf-8"))
    print("\n".join(describe(checks)))
    return RESTORED_AGAIN if checks["restored"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
