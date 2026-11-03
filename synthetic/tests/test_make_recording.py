"""실제 solidcraft-cli로 서랍장 합성 녹화본을 만든다. SolidCraft가 없으면 건너뛴다."""

import hashlib
import json
import os
from pathlib import Path

import pytest

from server.bundle import bundle_errors
from synthetic.make_recording import make_recording
from synthetic.solidcraft_model import DEFAULT_CLI

ROOT = Path(__file__).resolve().parents[2]
DRAWER = ROOT / "solidcraft-test" / "drawer.sc"
CLI = os.environ.get("SOLIDCRAFT_CLI", DEFAULT_CLI)

pytestmark = [
    pytest.mark.solidcraft,
    pytest.mark.skipif(not Path(CLI).is_file(), reason="solidcraft-cli가 없음"),
]


def test_등판_기울기가_있는_벤치는_기울기만_비선형_구간에서_샘플이_늘어난다(tmp_path: Path) -> None:
    # solidcraft-test/bench-tilt.sc: 앉음판과 back_angle만큼 X축으로 도는 등판. 등판 점이 원호를 그린다.
    out = make_recording(ROOT / "solidcraft-test" / "bench-tilt.sc", tmp_path / "bench-tilt.json", [])

    bundle = json.loads(out.read_text(encoding="utf-8"))
    assert bundle_errors(bundle) == []
    width, angle = bundle["sweeps"]
    assert [s["value"] for s in width["samples"]] == [400.0, 600.0, 800.0, 1000.0, 1200.0]
    assert angle["parameter"] == "back_angle"
    assert 5 < len(angle["samples"]) <= 17
    assert "interpolation_failure" not in angle and "reductions" not in angle
    # 저장소의 녹화본과 같은 샘플 위치다
    recorded = json.loads((ROOT / "fixtures" / "synthetic" / "bench-tilt.json").read_text(encoding="utf-8"))
    assert [s["value"] for s in angle["samples"]] == [s["value"] for s in recorded["sweeps"][1]["samples"]]


def test_서랍장_합성_녹화본이_검사를_통과하고_원본은_바뀌지_않는다(tmp_path: Path) -> None:
    before = hashlib.sha1(DRAWER.read_bytes()).hexdigest()

    out = make_recording(DRAWER, tmp_path / "drawer.json", ["d6"])

    bundle = json.loads(out.read_text(encoding="utf-8"))
    assert bundle_errors(bundle) == []
    assert bundle["source"] == "solidcraft"
    assert [s["parameter"] for s in bundle["sweeps"]] == ["body_w", "body_d", "body_h", "drawer_d", "d6"]
    assert hashlib.sha1(DRAWER.read_bytes()).hexdigest() == before

    baseline = bundle["baseline"]
    assert {f["name"] for f in baseline["faces"]} >= {"F5:side:l1", "F2:side:l1"}
    assert len(baseline["faces"]) == 22 and len(baseline["edges"]) == 48
    assert [b["name"] for b in baseline["bodies"]] == ["Carcass", "DrawerBox"]
    assert baseline["bodies"][0]["volume"] == pytest.approx(27_217_728)

    # 바디 측정값이 손 계산과 맞는다: body_d 225에서 서랍 부피
    body_d = next(s for s in bundle["sweeps"] if s["parameter"] == "body_d")
    first = body_d["samples"][0]
    assert first["value"] == 225 and first["status"] == "ok"
    drawer = next(b for b in first["bodies"] if b["name"] == "DrawerBox")
    assert drawer["volume"] == pytest.approx(6_842_808)

    # 모든 샘플이 재계산되고 면 구성이 같다(속 비우기 면 지정점이 범위 안에서 유효함)
    samples = [x for s in bundle["sweeps"] for x in s["samples"]]
    assert {x["status"] for x in samples} == {"ok"}
    assert {tuple(f["name"] for f in x["faces"]) for x in samples} == {tuple(f["name"] for f in baseline["faces"])}
