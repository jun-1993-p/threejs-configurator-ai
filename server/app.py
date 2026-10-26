"""업로드 묶음을 받아 저장하고 녹화본으로 내보내는 서버."""

import json
import uuid
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException
from pydantic import BaseModel, Field

from server.bundle import bundle_errors


class RecordingRequest(BaseModel):
    # 녹화본 파일 이름. 경로 문자가 들어가지 않도록 제한한다.
    name: str = Field(pattern=r"^[A-Za-z0-9_\-가-힣]+$")


def create_app(data_dir: Path, recordings_dir: Path) -> FastAPI:
    app = FastAPI(title="구성기 서버")
    uploads_dir = data_dir / "uploads"

    def upload_path(upload_id: str) -> Path:
        path = uploads_dir / f"{upload_id}.json"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="업로드 묶음이 없습니다")
        return path

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/uploads", status_code=201)
    def create_upload(bundle: dict[str, Any] = Body()) -> dict[str, str]:
        errors = bundle_errors(bundle)
        if errors:
            raise HTTPException(status_code=422, detail=errors)
        upload_id = uuid.uuid4().hex
        uploads_dir.mkdir(parents=True, exist_ok=True)
        (uploads_dir / f"{upload_id}.json").write_text(
            json.dumps(bundle, ensure_ascii=False), encoding="utf-8"
        )
        return {"id": upload_id}

    @app.get("/uploads/{upload_id}")
    def get_upload(upload_id: str) -> Any:
        return json.loads(upload_path(upload_id).read_text(encoding="utf-8"))

    @app.post("/uploads/{upload_id}/recording", status_code=201)
    def record_upload(upload_id: str, request: RecordingRequest) -> dict[str, str]:
        source = upload_path(upload_id)
        recordings_dir.mkdir(parents=True, exist_ok=True)
        target = recordings_dir / f"{request.name}.json"
        target.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
        return {"name": request.name}

    return app
