"""SolidCraft 모델로 교차 검증 샘플(파라미터 두 개를 함께 바꾼 형상)을 뽑아 합성 녹화본으로 남긴다(티켓 07).

실행(저장소 루트에서):
    python -m synthetic.make_cross_checks solidcraft-test/drawer.sc --sample body_w=525,body_h=612.5 \
        --sample body_w=725,body_h=812.5 --out fixtures/synthetic/drawer.cross-checks.json

샘플 형식은 업로드 묶음의 단독 스윕 샘플과 같고 value 대신 values를 쓴다.
점 배치는 기본 형상에서 정하므로 같은 설계로 만든 합성 녹화본과 면·점 순서가 같다.
위상 묶음이 있는 녹화본은 --recording으로 넘기면 묶음마다 기준 형상을 먼저 들러, 기본 형상에 없는 면도
녹화본과 같은 배치로 놓는다(예: --recording fixtures/synthetic/shelf.json).
원본 설계 파일은 바뀌지 않는다.
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "addin" / "ConfiguratorUploader"))

from uploader.core import GRID_N, cross_check_sample  # noqa: E402

from synthetic.solidcraft_model import SolidCraftModel, cli_runner  # noqa: E402


def parse_values(text: str) -> dict[str, float]:
    """"body_w=525,body_h=612.5"를 {"body_w": 525.0, "body_h": 612.5}로 바꾼다."""
    pairs = [item.split("=", 1) for item in text.split(",")]
    if any(len(p) != 2 for p in pairs):
        raise ValueError(f"{text}: 이름=값을 쉼표로 이어 써야 합니다")
    return {name.strip(): float(value) for name, value in pairs}


def fix_group_layouts(model: SolidCraftModel, recording: dict[str, Any]) -> None:
    """녹화본의 위상 묶음마다 기준 형상을 들러 점 배치를 정한다. 배치는 면을 처음 본 형상에서 정해지기 때문이다."""
    parameters = {p.name: p for p in model.parameters()}
    for sweep in recording["sweeps"]:
        for group in sweep.get("groups", []):
            model.set_parameter(sweep["parameter"], group["anchor"])
            model.sample_faces(GRID_N)
            model.restore_parameter(parameters[sweep["parameter"]])


def make_cross_checks(
    design: Path, out: Path, samples: list[dict[str, float]], cli: str | None = None, recording: Path | None = None
) -> Path:
    model = SolidCraftModel(cli_runner(design, cli))
    model.fix_baseline_layouts(GRID_N)
    if recording is not None:
        fix_group_layouts(model, json.loads(recording.read_text(encoding="utf-8")))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {"source": "solidcraft", "grid": {"n": GRID_N}, "samples": [cross_check_sample(model, s) for s in samples]},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return out


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("design", type=Path, help="SolidCraft 설계 파일(.sc)")
    parser.add_argument("--out", type=Path, required=True, help="교차 검증 샘플 합성 녹화본 경로(.json)")
    parser.add_argument("--sample", type=parse_values, action="append", required=True, help="이름=값,이름=값")
    parser.add_argument("--cli", help="solidcraft-cli 경로(기본: SOLIDCRAFT_CLI 또는 설치 경로)")
    parser.add_argument("--recording", type=Path, help="위상 묶음이 있는 같은 설계의 합성 녹화본(.json)")
    args = parser.parse_args(argv)
    print(make_cross_checks(args.design.resolve(), args.out, args.sample, args.cli, args.recording))


if __name__ == "__main__":
    main()
