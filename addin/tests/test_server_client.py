"""건식 업로드의 파일 서버가 run_upload의 묶음을 폴더에 쓰고 그 ID를 돌려주는지 본다."""

import json
from pathlib import Path

from fakes import FakeModel
from uploader.core import run_upload
from uploader.server_client import FileServerClient


def test_건식_업로드는_묶음을_폴더에_쓰고_그_ID를_돌려준다(tmp_path: Path) -> None:
    upload_id = run_upload(FakeModel(), FileServerClient(tmp_path / "dry-runs"), lambda _: None)

    assert upload_id is not None and upload_id.startswith("dry-")
    bundle = json.loads((tmp_path / "dry-runs" / f"{upload_id}.json").read_text(encoding="utf-8"))
    assert [s["parameter"] for s in bundle["sweeps"]] == ["W", "D"]
