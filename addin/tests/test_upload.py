import json
from pathlib import Path

import jsonschema
from fakes import FakeModel, FakeServer
from uploader.core import BodyInfo, run_upload

SCHEMA_PATH = Path(__file__).parents[2] / "schema" / "upload-bundle.schema.json"


def test_서버_연결_시험이_실패하면_스윕하지_않고_운영자에게_알린다() -> None:
    model = FakeModel()
    server = FakeServer(reachable=False)
    messages: list[str] = []

    result = run_upload(model, server, messages.append)

    assert result is None
    assert model.set_calls == []
    assert server.uploaded == []
    assert any("서버" in m for m in messages)


def test_업로드_묶음에_파라미터마다_이름_값_수식_사용자_파라미터_여부가_담긴다() -> None:
    server = FakeServer()

    upload_id = run_upload(FakeModel(), server, lambda _: None)

    assert upload_id == "upload-1"
    assert server.uploaded[0]["parameters"] == [
        {"name": "W", "value": 800.0, "unit": "mm", "expression": "800 mm", "is_user": True},
        {"name": "D", "value": 400.0, "unit": "mm", "expression": "W / 2", "is_user": True},
        {"name": "d12", "value": 18.0, "unit": "mm", "expression": "18 mm", "is_user": False},
    ]


def test_사용자_파라미터마다_기본값_50퍼센트_범위에서_5점_균등으로_단독_스윕한다() -> None:
    model = FakeModel()
    server = FakeServer()

    run_upload(model, server, lambda _: None)

    sweeps = server.uploaded[0]["sweeps"]
    assert [s["parameter"] for s in sweeps] == ["W", "D"]
    assert sweeps[0]["range"] == {"min": 400.0, "max": 1200.0}
    assert [s["value"] for s in sweeps[0]["samples"]] == [400.0, 600.0, 800.0, 1000.0, 1200.0]
    assert [s["value"] for s in sweeps[1]["samples"]] == [200.0, 300.0, 400.0, 500.0, 600.0]


def test_단독_스윕이_끝나면_파라미터를_기본값으로_되돌린다() -> None:
    model = FakeModel()

    run_upload(model, FakeServer(), lambda _: None)

    assert model.values == {"W": 800.0, "D": 400.0, "d12": 18.0}
    assert ("d12", 9.0) not in model.set_calls


def test_단독_스윕이_끝나면_원래_수식을_되돌려_자식_관계를_지킨다() -> None:
    model = FakeModel()

    run_upload(model, FakeServer(), lambda _: None)

    assert model.expressions["D"] == "W / 2"
    assert model.expressions["W"] == "800 mm"


def test_같은_면_구성이면_모든_샘플의_꼭짓점_수가_같고_면마다_격자_점이다() -> None:
    server = FakeServer()

    run_upload(FakeModel(), server, lambda _: None)

    bundle = server.uploaded[0]
    grid_n = bundle["grid"]["n"]
    samples = [bundle["baseline"]] + [s for sw in bundle["sweeps"] for s in sw["samples"]]
    counts = {sum(len(f["points"]) for f in s["faces"]) for s in samples}
    assert counts == {3 * grid_n * grid_n}
    assert all(len(f["points"]) == grid_n * grid_n for s in samples for f in s["faces"])


def test_재계산이_실패한_샘플은_실패로_기록하고_스윕을_이어간다() -> None:
    model = FakeModel(failing_values={"W": {1200.0}})
    server = FakeServer()

    run_upload(model, server, lambda _: None)

    w_samples = server.uploaded[0]["sweeps"][0]["samples"]
    assert [s["status"] for s in w_samples] == ["ok", "ok", "ok", "ok", "recompute_failed"]
    assert w_samples[-1]["faces"] == []
    assert model.values["W"] == 800.0


def test_업로드_묶음이_업로드_묶음_스키마를_통과한다() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    server = FakeServer()

    run_upload(FakeModel(failing_values={"W": {1200.0}}), server, lambda _: None)

    jsonschema.validate(server.uploaded[0], schema)


def test_부품은_컴포넌트_단위이고_컴포넌트_안의_바디는_합친다() -> None:
    model = FakeModel(
        bodies=[
            BodyInfo(name="Body1", component="상판"),
            BodyInfo(name="Body2", component="상판"),
            BodyInfo(name="Body3", component="측판"),
        ]
    )
    server = FakeServer()

    run_upload(model, server, lambda _: None)

    assert server.uploaded[0]["parts"] == [
        {"name": "상판", "kind": "component", "faces": [0, 1]},
        {"name": "측판", "kind": "component", "faces": [2]},
    ]


def test_컴포넌트가_없는_바디는_바디_하나가_부품_하나다() -> None:
    model = FakeModel(
        bodies=[
            BodyInfo(name="Body1", component=None),
            BodyInfo(name="Body2", component=None),
            BodyInfo(name="Body3", component=None),
        ]
    )
    server = FakeServer()

    run_upload(model, server, lambda _: None)

    assert server.uploaded[0]["parts"] == [
        {"name": "Body1", "kind": "body", "faces": [0]},
        {"name": "Body2", "kind": "body", "faces": [1]},
        {"name": "Body3", "kind": "body", "faces": [2]},
    ]
