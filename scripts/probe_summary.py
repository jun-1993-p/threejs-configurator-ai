"""Fusion 탐색 스크립트(addin/FaceNameProbe)의 결과를 사람이 읽을 요점으로 줄인다. 탐색 위저드가 부른다.

    .venv/Scripts/python -m scripts.probe_summary data/probes/<이름>.json
    .venv/Scripts/python -m scripts.probe_summary --restored data/probes/<이름>.json

--restored는 원래대로가 아니면 종료 코드 NOT_RESTORED로 끝난다. 위저드는 문장이 아니라 종료 코드로 판정한다.
"""

import json
import sys
from pathlib import Path
from typing import Any

NOT_RESTORED = 3


def summarize(result: dict[str, Any]) -> list[str]:
    bodies = result["base"]["bodies"]
    faces = sum(len(b.get("faces", [])) for b in bodies)
    edges = sum(len(b.get("edges", [])) for b in bodies)
    lines = [
        f"Fusion {result['fusion_version']} · {result['design_type']} · 문서 {result['document']}",
        f"보이는 바디 {len(bodies)} · 면 {faces} · 모서리 {edges} · 오커런스 {len(result['occurrences'])}"
        f" · 피처 {len(result['base']['features'])}",
    ]
    for v in result["variants"]:
        c = v.get("compare")
        if c is None:
            lines.append(f"  {v['parameter']}: 바꿔 보지 못함")
            continue
        lines.append(
            f"  {v['parameter']} = {v['value_mm']:.1f} mm: 면 {c['faces_variant']}/{c['faces_base']}"
            f" · 표시 유지 {c['tags_kept']} · tempId 같음 {c['same_tempId']} · 토큰 같음 {c['same_token']}"
            f" · 역할 같음 {c['same_roles']} · 타임라인 오류 {c['errors_in_timeline']}"
        )
    lines.append(f"되돌린 뒤 타임라인 오류 {result['errors_after_restore']} · 탐색 중 오류 {len(result['probe_errors'])}건")
    lines += [f"  {e}" for e in result["probe_errors"][:5]]
    return lines


def restored(result: dict[str, Any]) -> list[str]:
    """탐색이 바꿔 본 파라미터가 원래 수식으로 돌아왔는지, 타임라인 오류가 늘지 않았는지. 사람이 매개변수 창과
    비교하지 않아도 되게 탐색 결과만으로 잰다(CODING_STANDARDS.md 「위저드」). 문제가 없으면 빈 목록이다."""
    after = result["restored_expressions"]
    original = {v["parameter"]: v["expression"] for v in result["variants"]}
    lines = [f"{name}: {expr} → {after.get(name)}" for name, expr in original.items() if after.get(name) != expr]
    errors_before, errors_after = result["base"]["errors_in_timeline"], result["errors_after_restore"]
    if errors_after > errors_before:
        lines.append(f"타임라인 오류가 {errors_before}개에서 {errors_after}개로 늘었다")
    return lines


def main(args: list[str]) -> int:
    result = json.loads(Path(args[-1]).read_text(encoding="utf-8"))
    if args[0] != "--restored":
        print("\n".join(summarize(result)))
        return 0
    problems = restored(result)
    print("; ".join(problems) if problems else "모두 원래대로")
    return NOT_RESTORED if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
