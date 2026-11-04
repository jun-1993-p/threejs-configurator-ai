"""녹화본 요점이 부품·스윕·위상 묶음을 찍고, 표면에서 벗어난 점과 이음선이 빠진 반쪽 원기둥을 알아보는지 본다."""

import json
import math
from pathlib import Path
from typing import Any

import pytest

from scripts.recording_summary import broken_halves, off_surface, summarize


@pytest.fixture
def no_bundle_check(monkeypatch: pytest.MonkeyPatch) -> None:
    """묶음 검사는 서버 시험이 맡고, 합성 녹화본 하나에 6~11초 걸린다. 다른 요점 줄을 보는 시험에서는 뺀다."""
    monkeypatch.setattr("scripts.recording_summary.bundle_errors", lambda bundle: [])


def _load(name: str) -> dict[str, Any]:
    bundle: dict[str, Any] = json.loads(Path(f"fixtures/synthetic/{name}.json").read_text(encoding="utf-8"))
    return bundle


def test_합성_서랍장_녹화본의_요점(no_bundle_check: None) -> None:
    bundle = _load("drawer")

    lines = summarize(bundle)

    assert any(line.startswith("사용자 파라미터 body_w = ") for line in lines)
    assert sum(line.startswith("부품 ") for line in lines) == len(bundle["parts"])
    assert any(line.startswith("스윕 body_w: ") and ":same" in line for line in lines)
    off = next(line for line in lines if line.startswith("점이 표면에서"))
    assert float(off.split(": ")[1].split()[0]) < 1e-6
    assert lines[-1] == "서버 묶음 검사: 통과"


def test_건식_업로드_묶음의_형식_오류는_서버_묶음_검사로_찍는다() -> None:
    bundle = _load("drawer")
    del bundle["baseline"]["faces"][0]["name"]

    lines = summarize(bundle)

    assert any(line.startswith("서버 묶음 검사: 오류 ") for line in lines)


def test_애드인이_쓴_꼴의_수식은_앞_업로드가_남긴_값일_수_있다고_알린다(no_bundle_check: None) -> None:
    bundle = _load("drawer")
    for p in bundle["parameters"]:
        if p["name"] == "body_w":
            p["expression"] = "450.0 mm"

    lines = summarize(bundle)

    assert "애드인이 쓴 꼴의 수식(앞 업로드가 끊겨 남긴 값일 수 있음): body_w = 450.0 mm" in lines
    assert not any("애드인이 쓴 꼴" in line for line in summarize(_load("drawer")))


def test_위상_묶음_안의_스윕은_묶음을_밝혀_따로_찍는다(no_bundle_check: None) -> None:
    lines = summarize(_load("shelf"))

    assert any(line.startswith("스윕 묶음 shelf_w ") and " 안의 " in line for line in lines)


def test_표면에서_벗어난_점의_거리를_잰다() -> None:
    plane = {"geometry": {"type": "plane", "normal": [0, 0, 2]}, "points": [[0, 0, 5], [3, 1, 5], [1, 1, 5.25]]}
    cylinder = {
        "geometry": {"type": "cylinder", "origin": [0, 0, 0], "axis": [0, 0, -1], "radius": 10},
        "points": [[10, 0, 3], [0, -10, 8], [math.sqrt(50), math.sqrt(50), 1], [0, 10.5, 2]],
    }

    assert off_surface(plane) == pytest.approx(0.25)
    assert off_surface(cylinder) == pytest.approx(0.5)


def test_짝_반쪽이나_이음선이_빠진_반쪽_원기둥을_찾는다() -> None:
    faces = [{"body": "b", "name": n} for n in ("leg:half1", "leg:half2", "hole:half1", "hole:half2")]
    edges = [
        {"body": "b", "name": "leg:half1|leg:half2~1"},
        {"body": "b", "name": "leg:half1|leg:half2~2"},
        {"body": "b", "name": "hole:half1|hole:half2~1"},
    ]

    assert broken_halves({"faces": faces, "edges": edges}) == ["b/hole"]
