"""추가 샘플 요청 중계(ADR-0013). 파이프라인이 요청을 걸고, 업로드 뒤 연결된 애드인이 가져가 답한다."""

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from server.app import FUSION_TIMEOUT_S, create_app
from server.tests.test_ingest import _bundle, _edges, _face


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def client(tmp_path: Path, clock: Clock) -> TestClient:
    return TestClient(create_app(data_dir=tmp_path / "data", recordings_dir=tmp_path / "rec", clock=clock))


@pytest.fixture
def upload_id(client: TestClient) -> str:
    return str(client.post("/uploads", json=_bundle()).json()["id"])


def _response(*values: dict[str, float]) -> dict[str, Any]:
    return {"samples": [{"values": v, "status": "ok", "faces": [_face("Body1")], "edges": _edges("Body1")} for v in values]}


def test_파이프라인이_건_요청을_애드인이_가져가_답하면_파이프라인이_응답을_받는다(client: TestClient, upload_id: str) -> None:
    values = [{"W": 600.0, "D": 250.0}]
    request_id = client.post(f"/uploads/{upload_id}/sample-requests", json={"kind": "cross", "values": values}).json()["id"]

    taken = client.get(f"/uploads/{upload_id}/sample-requests/next")
    assert taken.json() == {"id": request_id, "kind": "cross", "values": values}
    assert client.get(f"/uploads/{upload_id}/sample-requests/{request_id}").json()["status"] == "pending"

    assert client.post(f"/uploads/{upload_id}/sample-requests/{request_id}/response", json=_response(*values)).status_code == 204
    answered = client.get(f"/uploads/{upload_id}/sample-requests/{request_id}").json()
    assert answered["status"] == "answered"
    assert answered["response"] == _response(*values)
    assert client.get(f"/uploads/{upload_id}/sample-requests/next").status_code == 204


def test_답하지_않은_요청은_애드인이_다시_붙으면_다시_가져간다(client: TestClient, upload_id: str) -> None:
    request_id = client.post(f"/uploads/{upload_id}/sample-requests", json={"kind": "cross", "values": [{"W": 600.0}]}).json()["id"]

    client.get(f"/uploads/{upload_id}/sample-requests/next")

    assert client.get(f"/uploads/{upload_id}/sample-requests/next").json()["id"] == request_id


def test_응답이_형식에_맞지_않거나_값_묶음_수가_다르면_거절한다(client: TestClient, upload_id: str) -> None:
    request_id = client.post(f"/uploads/{upload_id}/sample-requests", json={"kind": "cross", "values": [{"W": 600.0}]}).json()["id"]
    url = f"/uploads/{upload_id}/sample-requests/{request_id}/response"

    assert client.post(url, json={"samples": [{"value": 600.0}]}).status_code == 422
    assert client.post(url, json=_response({"W": 600.0}, {"W": 700.0})).status_code == 422
    assert client.post(url, json=_response({"W": 700.0})).status_code == 422
    assert client.get(f"/uploads/{upload_id}/sample-requests/{request_id}").json()["status"] == "pending"


def test_애드인이_샘플을_뽑지_못하면_실패_이유를_파이프라인에_넘기고_다시_내주지_않는다(client: TestClient, upload_id: str) -> None:
    request_id = client.post(f"/uploads/{upload_id}/sample-requests", json={"kind": "cross", "values": [{"W": 600.0}]}).json()["id"]

    failed = client.post(f"/uploads/{upload_id}/sample-requests/{request_id}/failure", json={"reason": "모델에 없는 파라미터: W"})

    assert failed.status_code == 204
    got = client.get(f"/uploads/{upload_id}/sample-requests/{request_id}").json()
    assert (got["status"], got["reason"]) == ("failed", "모델에 없는 파라미터: W")
    assert client.get(f"/uploads/{upload_id}/sample-requests/next").status_code == 204


def test_애드인이_한동안_찾지_않으면_Fusion_연결이_끊긴_것으로_본다(client: TestClient, upload_id: str, clock: Clock) -> None:
    request_id = client.post(f"/uploads/{upload_id}/sample-requests", json={"kind": "cross", "values": [{"W": 600.0}]}).json()["id"]

    def status() -> str:
        return str(client.get(f"/uploads/{upload_id}/sample-requests/{request_id}").json()["fusion"])

    assert status() == "disconnected"
    client.post(f"/uploads/{upload_id}/fusion")
    assert status() == "connected"
    clock.now += FUSION_TIMEOUT_S + 1
    assert status() == "disconnected"
    client.get(f"/uploads/{upload_id}/sample-requests/next")
    assert status() == "connected"


def test_없는_업로드_묶음이나_요청은_찾을_수_없다(client: TestClient, upload_id: str) -> None:
    assert client.post("/uploads/none/sample-requests", json={"kind": "cross", "values": [{"W": 1.0}]}).status_code == 404
    assert client.get("/uploads/none/sample-requests/next").status_code == 404
    assert client.get(f"/uploads/{upload_id}/sample-requests/none").status_code == 404
