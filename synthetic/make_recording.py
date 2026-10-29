"""SolidCraft 모델로 합성 녹화본을 만든다(티켓 24).

실행(저장소 루트에서):
    python -m synthetic.make_recording solidcraft-test/drawer.sc --extra d6 --out fixtures/synthetic/drawer.json

사용자 파라미터마다 기본값 ±50% 5점 단독 스윕을 돌린다. --extra로 이름을 넘긴 스케치 치수도 함께 스윕한다.
결과가 업로드 묶음 검사를 통과할 때만 파일을 쓴다. 원본 설계 파일은 바뀌지 않는다.
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "addin" / "ConfiguratorUploader"))

from server.bundle import bundle_errors  # noqa: E402
from uploader.core import run_upload  # noqa: E402

from synthetic.solidcraft_model import SolidCraftModel, cli_runner  # noqa: E402


class BundleFile:
    """업로드 대신 묶음을 검사해 파일로 쓰는 ServerClient."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def ping(self) -> bool:
        return True

    def upload(self, bundle: dict[str, Any]) -> str:
        errors = bundle_errors(bundle)
        if errors:
            raise ValueError("업로드 묶음 검사 실패:\n" + "\n".join(errors))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(bundle, ensure_ascii=False), encoding="utf-8")
        return str(self.path)


def make_recording(design: Path, out: Path, extra: list[str], cli: str | None = None) -> Path:
    model = SolidCraftModel(cli_runner(design, cli))
    written = run_upload(model, BundleFile(out), print, source="solidcraft", extra_sweeps=extra)
    assert written is not None
    return Path(written)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("design", type=Path, help="SolidCraft 설계 파일(.sc)")
    parser.add_argument("--out", type=Path, required=True, help="합성 녹화본 경로(.json)")
    parser.add_argument("--extra", action="append", default=[], help="함께 스윕할 비사용자 파라미터 이름")
    parser.add_argument("--cli", help="solidcraft-cli 경로(기본: SOLIDCRAFT_CLI 또는 설치 경로)")
    args = parser.parse_args(argv)
    print(make_recording(args.design.resolve(), args.out, args.extra, args.cli))


if __name__ == "__main__":
    main()
