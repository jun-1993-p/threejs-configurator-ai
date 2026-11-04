"""녹화본(업로드 묶음) 하나를 사람이 읽을 요점으로 줄인다. Fusion 첫 업로드 확인(티켓 26 2절)에 쓴다.

    .venv/Scripts/python -m scripts.recording_summary fixtures/private/recordings/<이름>.json

파라미터, 부품마다 면 수와 기본 형상의 위치(mm), 면 종류와 반쪽으로 나눈 원기둥, 스윕마다 샘플 상태와 위상,
갈라지거나 새로 생긴 면 이름, 점이 표면에서 벗어난 정도를 찍는다. 묶음 검사는 서버가 업로드를 받을 때 한다.
"""

import json
import math
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from server.bundle import pair_faces, placed_shapes

_HALVES = (":half1", ":half2")


def off_surface(face: dict[str, Any]) -> float:
    """면의 점이 그 면의 표면 정의에서 벗어난 가장 큰 거리(mm). 평면은 법선 방향 퍼짐, 원기둥은 반지름 차이.

    점이 원 모서리·이음선을 따라 놓이므로, Fusion이 모서리를 어셈블리 좌표가 아닌 곳에 두면 여기서 드러난다.
    """
    g, points = face.get("geometry"), face["points"]
    if g is None or not points:
        return 0.0
    if g["type"] == "plane":
        n = g["normal"]
        k = math.sqrt(sum(c * c for c in n))
        heights = [float(sum(p[i] * n[i] for i in range(3))) / k for p in points]
        return max(heights) - min(heights)
    if g["type"] == "cylinder":
        origin, axis, radius = g["origin"], g["axis"], float(g["radius"])
        k = math.sqrt(sum(c * c for c in axis))
        worst = 0.0
        for p in points:
            rel = [p[i] - origin[i] for i in range(3)]
            along = sum(rel[i] * axis[i] for i in range(3)) / k
            worst = max(worst, abs(math.sqrt(max(0.0, sum(c * c for c in rel) - along * along)) - radius))
        return worst
    raise ValueError(f"면 {face.get('name')}: 표면 종류 {g['type']}는 잴 수 없습니다")


def broken_halves(shape: dict[str, Any]) -> list[str]:
    """반쪽으로 나눈 원기둥 중 짝 반쪽이나 두 이음선(~1, ~2)이 없는 것(Fusion 어댑터의 _edges)."""
    faces = {(f["body"], f["name"]) for f in shape["faces"]}
    edges = {(e["body"], e["name"]) for e in shape["edges"]}
    broken = []
    for body, name in sorted(faces):
        if not name.endswith(_HALVES[0]):
            continue
        stem = name[: -len(_HALVES[0])]
        seams = {(body, f"{stem}{_HALVES[0]}|{stem}{_HALVES[1]}~{k}") for k in (1, 2)}
        if (body, stem + _HALVES[1]) not in faces or not seams <= edges:
            broken.append(f"{body}/{stem}")
    return broken


def summarize(bundle: dict[str, Any]) -> list[str]:
    lines = [f"출처: {bundle.get('source')}"]
    params = bundle["parameters"]
    for p in params:
        if p["is_user"]:
            kind = " (개수형)" if p.get("is_count") else ""
            lines.append(f"사용자 파라미터 {p['name']} = {p['value']:g} {p['unit']}{kind}  [{p['expression']}]")
    lines.append(f"모델 파라미터 {sum(1 for p in params if not p['is_user'])}개(스윕하지 않음)")
    baseline = bundle["baseline"]
    for part in bundle["parts"]:
        points = [q for i in part["faces"] for q in baseline["faces"][i]["points"]]
        low = [min(q[i] for q in points) for i in range(3)]
        high = [max(q[i] for q in points) for i in range(3)]
        box = " ~ ".join("(" + ", ".join(f"{c:.1f}" for c in corner) + ")" for corner in (low, high))
        lines.append(f"부품 {part['name']} ({part['kind']}): 면 {len(part['faces'])}개, 위치 {box}")
    kinds = Counter(f["surface"] for f in baseline["faces"])
    halves = sum(1 for f in baseline["faces"] if f["name"].endswith(_HALVES[0]))
    lines.append(f"면 종류: {dict(kinds)}, 반쪽으로 나눈 원기둥 {halves}개")

    shapes = [baseline] + [g["baseline"] for sweep in bundle["sweeps"] for g in sweep.get("groups", [])]
    states: dict[tuple[str, str], list[str]] = {}
    renamed: Counter[str] = Counter()
    for key in ("samples", "checks"):
        for where, (parameter, sample, faces) in placed_shapes(bundle, key):
            if sample["status"] != "ok":
                state = "failed"
            else:
                shapes.append(sample)
                state = "same" if pair_faces(faces, sample["faces"]) is not None else "changed"
                renamed.update(m for f in sample["faces"] for m in (":split", ":new") if m in f["name"])
            if key == "samples":
                states.setdefault((where, parameter), []).append(f"{sample['value']:g}:{state}")
    for (where, parameter), values in states.items():
        lines.append(f"스윕 {f'{where} 안의 ' if where else ''}{parameter}: {' '.join(values)}")
    lines.append(f"갈라진 면 이름(:split) {renamed[':split']}개, 새 면 이름(:new) {renamed[':new']}개")
    broken = sorted({b for shape in shapes for b in broken_halves(shape)})
    lines.append(f"이음선이 빠진 반쪽 원기둥: {', '.join(broken) if broken else '없음'}")
    worst = max((off_surface(f) for shape in shapes for f in shape["faces"]), default=0.0)
    lines.append(f"점이 표면에서 벗어난 가장 큰 거리: {worst:.2e} mm")
    return lines


def main(path: str) -> None:
    for line in summarize(json.loads(Path(path).read_text(encoding="utf-8"))):
        print(line)


if __name__ == "__main__":
    main(sys.argv[1])
