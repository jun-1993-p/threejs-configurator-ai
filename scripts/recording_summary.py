"""녹화본(업로드 묶음) 하나를 사람이 읽을 요점으로 줄인다. Fusion 첫 업로드 확인(티켓 26 2절)에 쓴다.

    .venv/Scripts/python -m scripts.recording_summary fixtures/private/recordings/<이름>.json

파라미터, 부품마다 면 수와 기본 형상의 위치(mm), 면 종류와 반쪽으로 나눈 원기둥, 스윕마다 샘플 상태와 위상,
갈라지거나 새로 생긴 면 이름, 점이 표면에서 벗어난 정도, 서버의 묶음 검사 결과를 찍는다. 녹화본은 서버가 받을 때
이미 검사했으므로 늘 통과지만, 건식 업로드 묶음(data/dry-runs)은 서버를 거치지 않아 여기서 처음 검사한다.
"""

import json
import math
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from server.bundle import bundle_errors, pair_faces, placed_shapes

# 애드인 패키지는 저장소 루트에 없다. 시험은 pyproject의 pythonpath로 찾지만, 위저드가 `python -m`으로 부를 때는 여기서 넣는다.
sys.path.append(str(Path(__file__).resolve().parents[1] / "addin" / "ConfiguratorUploader"))
from uploader.core import ADDIN_EXPRESSION  # noqa: E402

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


def _ranges(bundle: dict[str, Any]) -> list[str]:
    """스윕마다 애드인이 남긴 범위(기본값 ±50%와 견줌), 범위를 줄인 까닭, 위상 묶음.

    범위가 기본값 한 점으로 줄면 그 스윕은 쓸 수 없다. 실물 선반에서 부품 이름이 재계산마다 바뀌어 모든 범위가 그렇게
    됐는데, 스윕 상태 줄만으로는 보이지 않았다(티켓 26).
    """
    defaults = {p["name"]: p["value"] for p in bundle["parameters"]}
    lines = []
    for sweep in bundle["sweeps"]:
        name, low, high = sweep["parameter"], sweep["range"]["min"], sweep["range"]["max"]
        base = defaults.get(name)
        head = f"범위 {name}: {low:g}~{high:g}"
        if base is None:
            # 서버 검사를 거치지 않은 건식 업로드 묶음은 스윕 파라미터가 목록에 없을 수 있다
            lines.append(f"{head} (기본값 없음)")
        else:
            full = sorted((base * 0.5, base * 1.5))
            # 줄었는지는 사람이 두 범위를 견주지 않게 도구가 판정해 찍는다
            shrunk = [side for side, cut in (("min", low > full[0]), ("max", high < full[1])) if cut]
            if low == high:
                note = " — 폭 0, 스윕을 쓸 수 없다"
            elif shrunk:
                note = f" — {'·'.join(shrunk)} 쪽이 줄었다"
            else:
                note = ""
            lines.append(f"{head} (기본값 {base:g}의 ±50%: {full[0]:g}~{full[1]:g}){note}")
        for r in sweep.get("reductions", []):
            removed = dict(Counter(f["body"] for f in r.get("removed_faces", [])))
            added = dict(Counter(f["body"] for f in r.get("added_faces", [])))
            lines.append(f"범위 줄임 {name} {r['side']} {r['at']:g} {r['reason']}: 사라진 면 {removed}, 새 면 {added}")
        groups = sweep.get("groups", [])
        if groups:
            spans = [
                f"{g['range']['min']:g}~{g['range']['max']:g} ({', '.join(f'{k}={v:g}' for k, v in g['counts'].items())})"
                for g in groups
            ]
            lines.append(f"위상 묶음 {name}: {', '.join(spans)}")
    return lines


def summarize(bundle: dict[str, Any]) -> list[str]:
    lines = [f"출처: {bundle.get('source')}"]
    # 나머지 요점은 형식이 맞는 묶음을 전제로 읽으므로, 형식 오류가 있으면 그것만 찍는다
    errors = bundle_errors(bundle)
    if errors:
        return lines + [f"서버 묶음 검사: 오류 {len(errors)}건"] + [f"  {e}" for e in errors[:10]]
    params = bundle["parameters"]
    for p in params:
        if p["is_user"]:
            kind = " (개수형)" if p.get("is_count") else ""
            lines.append(f"사용자 파라미터 {p['name']} = {p['value']:g} {p['unit']}{kind}  [{p['expression']}]")
    lines.append(f"모델 파라미터 {sum(1 for p in params if not p['is_user'])}개(스윕하지 않음)")
    leftovers = [f"{p['name']} = {p['expression']}" for p in params if p["is_user"] and ADDIN_EXPRESSION.match(p["expression"])]
    if leftovers:
        lines.append(f"애드인이 쓴 꼴의 수식(앞 업로드가 끊겨 남긴 값일 수 있음): {', '.join(leftovers)}")
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
    lines += _ranges(bundle)
    lines.append(f"갈라진 면 이름(:split) {renamed[':split']}개, 새 면 이름(:new) {renamed[':new']}개")
    broken = sorted({b for shape in shapes for b in broken_halves(shape)})
    lines.append(f"이음선이 빠진 반쪽 원기둥: {', '.join(broken) if broken else '없음'}")
    worst = max((off_surface(f) for shape in shapes for f in shape["faces"]), default=0.0)
    lines.append(f"점이 표면에서 벗어난 가장 큰 거리: {worst:.2e} mm")
    lines.append("서버 묶음 검사: 통과")
    return lines


def main(path: str) -> None:
    for line in summarize(json.loads(Path(path).read_text(encoding="utf-8"))):
        print(line)


if __name__ == "__main__":
    main(sys.argv[1])
