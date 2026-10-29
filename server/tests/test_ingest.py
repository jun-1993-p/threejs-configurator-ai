import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from server.app import create_app
from server.bundle import bundle_errors, sample_topology


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    return TestClient(create_app(data_dir=tmp_path / "data", recordings_dir=tmp_path / "rec"))


def test_연결_시험에_응답한다(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def _face(body: str, name: str = "F1:+z", width: float = 1, baseline: bool = False) -> dict[str, Any]:
    face: dict[str, Any] = {
        "body": body,
        "surface": "plane",
        "name": name,
        "geometry": {"type": "plane", "normal": [0, 0, 1]},
        "points": [[0, 0, 0], [width, 0, 0], [0, 1, 0], [width, 1, 0]],
    }
    if baseline:
        face["triangles"] = [[0, 1, 3], [0, 3, 2]]
    return face


def _edges(body: str) -> list[dict[str, Any]]:
    return [{"body": body, "name": "F1:+z|F1:-y", "start": [0, 0, 0], "mid": [0.5, 0, 0], "end": [1, 0, 0]}]


def _bundle() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "units": "mm",
        "grid": {"n": 2},
        "parameters": [
            {"name": "W", "value": 800, "unit": "mm", "expression": "800 mm", "is_user": True}
        ],
        "parts": [{"name": "상판", "kind": "component", "faces": [0]}],
        "baseline": {"faces": [_face("Body1", baseline=True)], "edges": _edges("Body1")},
        "sweeps": [
            {
                "parameter": "W",
                "range": {"min": 400, "max": 1200},
                "samples": [
                    {"value": 400, "status": "ok", "faces": [_face("Body1", width=0.5)], "edges": _edges("Body1")},
                    {"value": 1200, "status": "recompute_failed", "faces": [], "edges": []},
                ],
                "checks": [
                    {"value": 800, "status": "ok", "faces": [_face("Body1", width=0.75)], "edges": _edges("Body1")},
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


def test_같은_이름의_면인데_점_수가_기본_형상과_다르면_거절한다(client: TestClient) -> None:
    bundle = _bundle()
    bundle["sweeps"][0]["samples"][0]["faces"][0]["points"].pop()

    response = client.post("/uploads", json=bundle)

    assert response.status_code == 422
    assert "F1:+z" in response.text and "기본 형상" in response.text


def test_검증점의_면도_점_수가_기본_형상과_다르면_거절한다() -> None:
    bundle = _bundle()
    bundle["sweeps"][0]["checks"][0]["faces"][0]["points"].pop()

    assert any("W=800" in e for e in bundle_errors(bundle))


def test_평면_면에_표면_정의가_없으면_거절한다() -> None:
    bundle = _bundle()
    del bundle["baseline"]["faces"][0]["geometry"]

    assert any("geometry" in e for e in bundle_errors(bundle))


def test_면_이름이나_모서리가_없으면_거절한다(client: TestClient) -> None:
    no_name = _bundle()
    del no_name["baseline"]["faces"][0]["name"]
    no_edges = _bundle()
    del no_edges["sweeps"][0]["samples"][0]["edges"]

    assert client.post("/uploads", json=no_name).status_code == 422
    assert client.post("/uploads", json=no_edges).status_code == 422


def test_기본_형상의_면에_연결_정보가_없거나_점_번호를_벗어나면_거절한다(client: TestClient) -> None:
    missing = _bundle()
    del missing["baseline"]["faces"][0]["triangles"]
    out_of_range = _bundle()
    out_of_range["baseline"]["faces"][0]["triangles"] = [[0, 1, 4]]

    assert client.post("/uploads", json=missing).status_code == 422
    response = client.post("/uploads", json=out_of_range)
    assert response.status_code == 422
    assert "triangles" in response.text or "연결" in response.text


def test_면_구성이_바뀐_샘플은_거절하지_않고_위상_변화로_표시한다() -> None:
    bundle = _bundle()
    changed = bundle["sweeps"][0]["samples"][0]
    changed["faces"] = [_face("Body1", name="F1:+z"), _face("Body1", name="F9:new")]

    assert bundle_errors(bundle) == []
    assert sample_topology(bundle) == [("W", 400, "changed"), ("W", 1200, "failed")]


def test_이름이_같아도_법선이_뒤집힌_면은_짝으로_보지_않는다() -> None:
    bundle = _bundle()
    bundle["sweeps"][0]["samples"][0]["faces"][0]["geometry"]["normal"] = [0, 0, -1]

    assert sample_topology(bundle)[0] == ("W", 400, "changed")


def test_이름과_표면이_맞으면_같은_위상이다() -> None:
    assert sample_topology(_bundle())[0] == ("W", 400, "same")


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
