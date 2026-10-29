"""업로드 묶음을 받아 저장하고 녹화본으로 내보내는 서버."""

import json
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from fastapi import Body, FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

from server.bundle import bundle_errors, sample_response_errors

# 애드인이 이 시간(초) 넘게 서버를 찾지 않으면 Fusion 연결이 끊긴 것으로 본다.
# 애드인은 몇 초마다 요청을 가져가거나, 샘플을 뽑는 동안 연결 신호를 보낸다.
FUSION_TIMEOUT_S = 15.0


class RecordingRequest(BaseModel):
    # 녹화본 파일 이름. 경로 문자가 들어가지 않도록 제한한다.
    name: str = Field(pattern=r"^[A-Za-z0-9_\-가-힣]+$")


class SampleFailureBody(BaseModel):
    reason: str = Field(min_length=1)


class SampleRequestBody(BaseModel):
    kind: Literal["cross", "grid", "thickness"]
    values: list[dict[str, float]] = Field(min_length=1)


@dataclass
class _SampleRequest:
    id: str
    kind: str
    values: list[dict[str, float]]
    response: dict[str, Any] | None = None
    # 애드인이 샘플을 뽑지 못한 이유. 있으면 다시 내주지 않는다.
    failure: str | None = None

    @property
    def open(self) -> bool:
        return self.response is None and self.failure is None


def create_app(data_dir: Path, recordings_dir: Path, clock: Callable[[], float] = time.monotonic) -> FastAPI:
    """clock: 연결 판정에 쓰는 시계(초). 시험에서 바꿔 끼운다."""
    app = FastAPI(title="구성기 서버")
    uploads_dir = data_dir / "uploads"
    # 추가 샘플 요청과 애드인이 마지막으로 서버를 찾은 때. 업로드부터 최종 승인까지만 쓰므로 메모리에 둔다(ADR-0013).
    sample_requests: dict[str, list[_SampleRequest]] = {}
    fusion_seen: dict[str, float] = {}

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

    def find_request(upload_id: str, request_id: str) -> _SampleRequest:
        upload_path(upload_id)
        for request in sample_requests.get(upload_id, []):
            if request.id == request_id:
                return request
        raise HTTPException(status_code=404, detail="추가 샘플 요청이 없습니다")

    def seen(upload_id: str) -> None:
        fusion_seen[upload_id] = clock()

    # 파이프라인 쪽: 요청을 걸고, 응답과 Fusion 연결 상태를 본다.
    @app.post("/uploads/{upload_id}/sample-requests", status_code=201)
    def create_sample_request(upload_id: str, body: SampleRequestBody) -> dict[str, str]:
        upload_path(upload_id)
        request = _SampleRequest(id=uuid.uuid4().hex, kind=body.kind, values=body.values)
        sample_requests.setdefault(upload_id, []).append(request)
        return {"id": request.id}

    # 애드인 쪽: 답하지 않은 가장 오래된 요청을 가져가고 답한다. 가져가고 답하지 못한 요청은 다시 붙으면 또 받는다.
    # next는 요청 id 경로보다 먼저 등록해야 id로 잡히지 않는다.
    @app.get("/uploads/{upload_id}/sample-requests/next", response_model=None)
    def next_sample_request(upload_id: str) -> dict[str, Any] | Response:
        upload_path(upload_id)
        seen(upload_id)
        for request in sample_requests.get(upload_id, []):
            if request.open:
                return {"id": request.id, "kind": request.kind, "values": request.values}
        return Response(status_code=204)

    @app.get("/uploads/{upload_id}/sample-requests/{request_id}")
    def get_sample_request(upload_id: str, request_id: str) -> dict[str, Any]:
        request = find_request(upload_id, request_id)
        last = fusion_seen.get(upload_id)
        connected = last is not None and clock() - last <= FUSION_TIMEOUT_S
        out: dict[str, Any] = {"status": "pending", "fusion": "connected" if connected else "disconnected"}
        if request.response is not None:
            out.update(status="answered", response=request.response)
        if request.failure is not None:
            out.update(status="failed", reason=request.failure)
        return out

    @app.post("/uploads/{upload_id}/sample-requests/{request_id}/response", status_code=204)
    def answer_sample_request(upload_id: str, request_id: str, response: dict[str, Any] = Body()) -> None:
        request = find_request(upload_id, request_id)
        seen(upload_id)
        errors = sample_response_errors(request.values, response)
        if errors:
            raise HTTPException(status_code=422, detail=errors)
        request.response = response

    @app.post("/uploads/{upload_id}/sample-requests/{request_id}/failure", status_code=204)
    def fail_sample_request(upload_id: str, request_id: str, body: SampleFailureBody) -> None:
        request = find_request(upload_id, request_id)
        seen(upload_id)
        request.failure = body.reason

    @app.post("/uploads/{upload_id}/fusion", status_code=204)
    def fusion_heartbeat(upload_id: str) -> None:
        """샘플을 뽑느라 요청을 가져가지 못하는 동안 애드인이 보내는 연결 신호"""
        upload_path(upload_id)
        seen(upload_id)

    return app
