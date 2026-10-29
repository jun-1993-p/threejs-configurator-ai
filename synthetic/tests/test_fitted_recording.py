"""경계 맞춤 격자의 통과 조건(티켓 25)을 실제 solidcraft-cli 결과로 확인한다. SolidCraft가 없으면 건너뛴다."""

import json
import math
import os
import subprocess
from pathlib import Path
from typing import Any

import pytest

from server.bundle import bundle_errors, sample_topology
from synthetic.make_recording import make_recording
from synthetic.solidcraft_model import DEFAULT_CLI, edge_faces

ROOT = Path(__file__).resolve().parents[2]
CLI = os.environ.get("SOLIDCRAFT_CLI", DEFAULT_CLI)
pytestmark = pytest.mark.skipif(not Path(CLI).is_file(), reason="solidcraft-cli가 없음")

# 바뀌는 파라미터와 그 파라미터가 움직이는 축(서랍장: report.md 6절)
MOVE_AXIS = {"body_d": 1, "d6": 2}


@pytest.fixture(scope="module")
def drawer(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    out = make_recording(ROOT / "solidcraft-test" / "drawer.sc", tmp_path_factory.mktemp("d") / "drawer.json", ["d6"])
    bundle: dict[str, Any] = json.loads(out.read_text(encoding="utf-8"))
    return bundle


def _faces(sample: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    return {(f["body"], f["name"]): f for f in sample["faces"]}


def _inside_plane_face(p: list[float], face: dict[str, Any], edges: list[dict[str, Any]], names: set[str]) -> bool:
    """점이 평면 면의 경계 안(경계 포함)에 있는지. 모서리 끝점과 중간점으로 경계를 잇는다."""
    n = face["geometry"]["normal"]
    k = max(range(3), key=lambda i: abs(n[i]))
    a, b = [i for i in range(3) if i != k]
    segs = []
    for e in edges:
        if face["name"] in edge_faces(e["name"], names):
            segs += [(e["start"], e["mid"]), (e["mid"], e["end"])]
    x, y = p[a], p[b]
    hits = 0
    for s, t in segs:
        x0, y0, x1, y1 = s[a], s[b], t[a], t[b]
        dx, dy = x1 - x0, y1 - y0
        length = math.hypot(dx, dy)
        if length and abs((x - x0) * dy - (y - y0) * dx) / length < 1e-6 and -1e-9 <= ((x - x0) * dx + (y - y0) * dy) / length**2 <= 1 + 1e-9:
            return True
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * dx / dy:
            hits += 1
    return hits % 2 == 1


def test_합성_녹화본이_새_형식_검사를_통과하고_모든_샘플이_같은_위상이다(drawer: dict[str, Any]) -> None:
    assert bundle_errors(drawer) == []
    assert {state for _, _, state in sample_topology(drawer)} == {"same"}


def test_서랍장_10단계에서_고리_모양_면을_포함한_모든_면의_점_수와_순서가_같다(drawer: dict[str, Any]) -> None:
    base = _faces(drawer["baseline"])
    assert ("DrawerBox", "F5:side:l1") in base and ("Carcass", "F2:side:l1") in base
    for sweep in drawer["sweeps"]:
        if sweep["parameter"] not in MOVE_AXIS:
            continue
        for sample in sweep["samples"]:
            faces = _faces(sample)
            assert list(faces) == list(base)
            assert all(len(faces[k]["points"]) == len(base[k]["points"]) for k in base)


def test_모든_점이_면_안에_있다(drawer: dict[str, Any]) -> None:
    samples = [drawer["baseline"]] + [s for sw in drawer["sweeps"] for s in sw["samples"]]
    for sample in samples:
        for body in {f["body"] for f in sample["faces"]}:
            names = {f["name"] for f in sample["faces"] if f["body"] == body}
            edges = [e for e in sample["edges"] if e["body"] == body]
            for face in (f for f in sample["faces"] if f["body"] == body):
                outside = [p for p in face["points"] if not _inside_plane_face(p, face, edges, names)]
                assert outside == [], (sample.get("value"), body, face["name"], outside[:3])


def test_점은_바뀐_파라미터의_축으로만_움직인다(drawer: dict[str, Any]) -> None:
    base = _faces(drawer["baseline"])
    for sweep in drawer["sweeps"]:
        axis = MOVE_AXIS.get(sweep["parameter"])
        if axis is None:
            continue
        for sample in sweep["samples"]:
            faces = _faces(sample)
            off = max(
                abs(p[i] - q[i])
                for k in base
                for p, q in zip(faces[k]["points"], base[k]["points"], strict=True)
                for i in range(3)
                if i != axis
            )
            assert off <= 1e-6, (sweep["parameter"], sample["value"], off)


PLATE_SCRIPT = {
    "commands": [
        {"command": "parameters.change", "params": {"name": "w", "expression": "200 mm"}},
        {"command": "parameters.change", "params": {"name": "hd", "expression": "30 mm"}},
        {"command": "solid.box", "params": {"length": "w", "width": 100, "height": 20, "body_name": "Plate"}},
        {"command": "solid.hole", "params": {"position": ["w/2", 50, 20], "diameter": "hd"}},
        {"command": "solid.fillet", "params": {"edges": [[0, 0, 10]], "radius": 10}},
        {"command": "solid.cylinder", "params": {"radius": 15, "height": "w/4", "base": [0, 200, 0], "body_name": "Rod"}},
    ]
}


def test_원기둥_면이_있는_판재도_모든_샘플에서_점_수가_같고_점이_원기둥_위에_있다(tmp_path: Path) -> None:
    """구멍(반원기둥 둘), 필렛(사분원기둥), 통 원기둥이 있는 판재. w와 hd를 스윕한다."""
    script = tmp_path / "plate.json"
    script.write_text(json.dumps(PLATE_SCRIPT), encoding="utf-8")
    design = tmp_path / "plate.sc"
    subprocess.run([CLI, "run", str(script), "--save", str(design), "--quiet"], check=True)

    bundle = json.loads(make_recording(design, tmp_path / "plate-rec.json", []).read_text(encoding="utf-8"))

    assert bundle_errors(bundle) == []
    assert {state for _, _, state in sample_topology(bundle)} == {"same"}
    base = _faces(bundle["baseline"])
    assert sum(f["surface"] == "cylinder" for f in base.values()) == 5
    for sample in [bundle["baseline"]] + [s for sw in bundle["sweeps"] for s in sw["samples"]]:
        for key, face in _faces(sample).items():
            assert len(face["points"]) == len(base[key]["points"])
            if face["surface"] != "cylinder":
                continue
            g = face["geometry"]
            for p in face["points"]:
                rel = [p[i] - g["origin"][i] for i in range(3)]
                along = sum(rel[i] * g["axis"][i] for i in range(3))
                radial = math.sqrt(max(0.0, sum(c * c for c in rel) - along * along))
                assert radial == pytest.approx(g["radius"], abs=1e-6)


def _tri_normal(pts: list[list[float]], tri: list[int]) -> list[float]:
    a, b, c = (pts[i] for i in tri)
    u = [b[i] - a[i] for i in range(3)]
    v = [c[i] - a[i] for i in range(3)]
    return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]


def test_어느_샘플에서도_삼각형이_뒤집히거나_납작해지지_않는다(drawer: dict[str, Any]) -> None:
    base = _faces(drawer["baseline"])
    for sweep in drawer["sweeps"]:
        for sample in sweep["samples"]:
            faces = _faces(sample)
            for key, ref in base.items():
                for tri in ref["triangles"]:
                    n0 = _tri_normal(ref["points"], tri)
                    n1 = _tri_normal(faces[key]["points"], tri)
                    assert sum(x * y for x, y in zip(n0, n1, strict=True)) > 0, (sweep["parameter"], sample["value"], key, tri)
