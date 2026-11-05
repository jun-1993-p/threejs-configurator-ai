"""애드인 점검 파일(data/addin-checks/<업로드 ID>.json)을 읽는다. 녹화 위저드와 연결 확인 위저드가 부른다.

    .venv/Scripts/python -m scripts.addin_checks data/addin-checks/<업로드 ID>.json
    .venv/Scripts/python -m scripts.addin_checks latest data/addin-checks [<기준 파일>]

첫 꼴은 파라미터, 어셈블리 좌표, 재계산 실패 샘플의 세 줄이다. 키는 애드인의 _write_checks가 쓴다(docs/recording-guide.md 4-3).
업로드 뒤 다시 되돌린 파라미터가 있으면 종료 코드 RESTORED_AGAIN으로 끝난다. 위저드는 문장이 아니라 종료 코드로 판정한다.
latest는 애드인이 마지막으로(기준 파일이 있으면 그보다 뒤에) 점검 파일을 쓴 진짜 업로드의 ID를 찍는다. 없으면 아무것도 찍지 않는다.
"""

import json
import sys
from pathlib import Path
from typing import Any

RESTORED_ALL = "모두 원래대로"
RESTORED_AGAIN = 3
# 같은 폴더에 있지만 업로드의 점검 파일이 아닌 것: 애드인 상태 파일(티켓 33)과 건식 업로드(서버에 없음)
_NOT_UPLOADS = ("serving.json",)
_DRY_PREFIX = "dry-"


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


def latest_upload(folder: Path, newer_than: Path | None = None) -> str | None:
    """애드인이 가장 늦게 점검 파일을 쓴 업로드 ID. newer_than이 있으면 그 파일보다 뒤에 쓴 것만 본다."""
    since = newer_than.stat().st_mtime if newer_than is not None else float("-inf")
    files = [
        p
        for p in folder.glob("*.json")
        if p.name not in _NOT_UPLOADS and not p.name.startswith(_DRY_PREFIX) and p.stat().st_mtime > since
    ]
    return max(files, key=lambda p: p.stat().st_mtime).stem if files else None


def main(args: list[str]) -> int:
    if args[0] == "latest":
        found = latest_upload(Path(args[1]), Path(args[2]) if len(args) > 2 else None)
        if found:
            print(found)
        return 0
    checks = json.loads(Path(args[0]).read_text(encoding="utf-8"))
    print("\n".join(describe(checks)))
    return RESTORED_AGAIN if checks["restored"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
