import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from server.app import create_app


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    return TestClient(create_app(data_dir=tmp_path / "data", recordings_dir=tmp_path / "rec"))


def test_연결_시험에_응답한다(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def _face(body: str) -> dict[str, Any]:
    return {"body": body, "surface": "plane", "points": [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]]}


def _bundle() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "units": "mm",
        "grid": {"n": 2},
        "parameters": [
            {"name": "W", "value": 800, "unit": "mm", "expression": "800 mm", "is_user": True}
        ],
        "parts": [{"name": "상판", "kind": "component", "faces": [0]}],
        "baseline": {"faces": [_face("Body1")]},
        "sweeps": [
            {
                "parameter": "W",
                "range": {"min": 400, "max": 1200},
                "samples": [
                    {"value": 400, "status": "ok", "faces": [_face("Body1")]},
                    {"value": 1200, "status": "recompute_failed", "faces": []},
                ],
            }
        ],
    }


def test_업로드_묶음을_받아_저장하고_다시_돌려준다(client: TestClient) -> None:
    created = client.post("/uploads", json=_bundle())

    assert created.status_code == 201
    upload_id = created.json()["id"]
    assert client.get(f"/uploads/{upload_id}").json() == _bundle()


def test_업로드_묶음_스키마에_맞지_않으면_거절한다(client: TestClient) -> None:
    bundle = _bundle()
    del bundle["parts"]

    response = client.post("/uploads", json=bundle)

    assert response.status_code == 422
    assert "parts" in response.text


def test_면의_점_수가_격자와_다르면_거절한다(client: TestClient) -> None:
    bundle = _bundle()
    bundle["sweeps"][0]["samples"][0]["faces"][0]["points"].pop()

    response = client.post("/uploads", json=bundle)

    assert response.status_code == 422
    assert "격자" in response.text


def test_저장된_업로드_묶음을_녹화본으로_내보낸다(client: TestClient, tmp_path: Path) -> None:
    upload_id = client.post("/uploads", json=_bundle()).json()["id"]

    response = client.post(f"/uploads/{upload_id}/recording", json={"name": "stool1"})

    assert response.status_code == 201
    recorded = tmp_path / "rec" / "stool1.json"
    assert json.loads(recorded.read_text(encoding="utf-8")) == _bundle()


def test_녹화본_이름에_경로가_들어가면_거절한다(client: TestClient, tmp_path: Path) -> None:
    upload_id = client.post("/uploads", json=_bundle()).json()["id"]

    response = client.post(f"/uploads/{upload_id}/recording", json={"name": "../stool1"})

    assert response.status_code == 422
    assert not (tmp_path / "stool1.json").exists()


def test_없는_업로드_묶음은_녹화할_수_없다(client: TestClient) -> None:
    response = client.post("/uploads/없음/recording", json={"name": "stool1"})

    assert response.status_code == 404
