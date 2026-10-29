"""교차 검증 샘플 합성 녹화본 도구. 실제 solidcraft-cli가 필요한 시험은 SolidCraft가 없으면 건너뛴다."""

import json
import os
from pathlib import Path

import pytest

from synthetic.make_cross_checks import make_cross_checks, parse_values
from synthetic.solidcraft_model import DEFAULT_CLI

ROOT = Path(__file__).resolve().parents[2]
DRAWER = ROOT / "solidcraft-test" / "drawer.sc"
CLI = os.environ.get("SOLIDCRAFT_CLI", DEFAULT_CLI)


def test_파라미터_값_문자열을_이름과_값으로_나눈다() -> None:
    assert parse_values("body_w=525, body_h=612.5") == {"body_w": 525.0, "body_h": 612.5}
    with pytest.raises(ValueError):
        parse_values("body_w")


@pytest.mark.skipif(not Path(CLI).is_file(), reason="solidcraft-cli가 없음")
def test_교차_검증_샘플은_합성_녹화본과_같은_면_순서로_두_파라미터가_함께_바뀐다(tmp_path: Path) -> None:
    out = make_cross_checks(DRAWER, tmp_path / "cross-checks.json", [{"body_w": 525.0, "body_h": 612.5}])

    sample = json.loads(out.read_text(encoding="utf-8"))["samples"][0]
    recording = json.loads((ROOT / "fixtures" / "synthetic" / "drawer.json").read_text(encoding="utf-8"))
    assert sample["values"] == {"body_w": 525.0, "body_h": 612.5} and sample["status"] == "ok"
    assert [f["name"] for f in sample["faces"]] == [f["name"] for f in recording["baseline"]["faces"]]
    assert [len(f["points"]) for f in sample["faces"]] == [len(f["points"]) for f in recording["baseline"]["faces"]]
    carcass = next(b for b in sample["bodies"] if b["name"] == "Carcass")
    assert carcass["bbox"]["max"][0] - carcass["bbox"]["min"][0] == pytest.approx(525)
    assert carcass["bbox"]["max"][2] - carcass["bbox"]["min"][2] == pytest.approx(612.5)
