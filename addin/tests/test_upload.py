import json
from pathlib import Path

import jsonschema
import pytest
from fakes import FakeModel, FakeServer, FakeMeasuringModel
from server.bundle import sample_response_errors
from uploader.core import BodyInfo, cross_check_sample, run_upload, serve_sample_request

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


def test_단독_스윕마다_이웃_샘플_사이_가운데_값에서_검증점_형상을_뽑는다() -> None:
    server = FakeServer()

    run_upload(FakeModel(), server, lambda _: None)

    w = server.uploaded[0]["sweeps"][0]
    assert [c["value"] for c in w["checks"]] == [500.0, 700.0, 900.0, 1100.0]
    assert {c["status"] for c in w["checks"]} == {"ok"}
    assert all(len(c["faces"]) == len(w["samples"][0]["faces"]) for c in w["checks"])


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


def test_만든_도구가_업로드_묶음에_적힌다() -> None:
    server = FakeServer()

    run_upload(FakeModel(), server, lambda _: None)
    run_upload(FakeModel(), server, lambda _: None, source="solidcraft")

    assert [b["source"] for b in server.uploaded] == ["fusion", "solidcraft"]


def test_사용자_파라미터가_아닌_파라미터도_이름을_넘기면_함께_스윕한다() -> None:
    model = FakeModel()
    server = FakeServer()

    run_upload(model, server, lambda _: None, extra_sweeps=["d12"])

    bundle = server.uploaded[0]
    assert [s["parameter"] for s in bundle["sweeps"]] == ["W", "D", "d12"]
    assert [s["value"] for s in bundle["sweeps"][2]["samples"]] == [9.0, 13.5, 18.0, 22.5, 27.0]
    # 사용자 파라미터 여부는 그대로 둔다
    assert bundle["parameters"][2]["is_user"] is False
    assert model.expressions["d12"] == "18 mm"


def test_샘플마다_면_이름과_모서리를_담고_연결은_기본_형상에만_담는다() -> None:
    server = FakeServer()

    run_upload(FakeModel(), server, lambda _: None)

    bundle = server.uploaded[0]
    baseline = bundle["baseline"]
    assert baseline["faces"][0]["name"] == "F1:top"
    assert baseline["faces"][0]["geometry"] == {"type": "plane", "normal": [0.0, 0.0, 1.0]}
    assert len(baseline["faces"][0]["triangles"]) == 2 * (bundle["grid"]["n"] - 1) ** 2
    assert baseline["edges"][0] == {
        "body": "Body1",
        "name": "F1:top|F1:side",
        "start": [0.0, 0.0, 0.0],
        "mid": [400.0, 0.0, 0.0],
        "end": [800.0, 0.0, 0.0],
    }
    w_first = bundle["sweeps"][0]["samples"][0]
    assert w_first["edges"][0]["end"] == [400.0, 0.0, 0.0]
    assert "triangles" not in w_first["faces"][0]
    assert "bodies" not in baseline


def test_바디_측정값을_주는_모델이면_샘플마다_담는다() -> None:
    server = FakeServer()

    run_upload(FakeMeasuringModel(), server, lambda _: None)

    bundle = server.uploaded[0]
    assert bundle["baseline"]["bodies"][0] == {
        "name": "Body1",
        "volume": 800.0 * 400.0 * 18.0,
        "bbox": {"min": [0.0, 0.0, 0.0], "max": [800.0, 400.0, 18.0]},
    }
    assert bundle["sweeps"][0]["samples"][0]["bodies"][0]["volume"] == 400.0 * 400.0 * 18.0


def test_이름과_측정값이_담긴_묶음도_스키마를_통과한다() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    server = FakeServer()

    run_upload(FakeMeasuringModel(failing_values={"W": {1200.0}}), server, lambda _: None, source="solidcraft")

    jsonschema.validate(server.uploaded[0], schema)


def test_교차_검증_샘플은_두_파라미터를_함께_바꾼_형상을_샘플과_같은_형식으로_뽑고_수식을_되돌린다() -> None:
    model = FakeModel()

    sample = cross_check_sample(model, {"W": 600.0, "D": 250.0})

    assert sample["values"] == {"W": 600.0, "D": 250.0}
    assert sample["status"] == "ok"
    xs = [p[0] for f in sample["faces"] for p in f["points"]]
    ys = [p[1] for f in sample["faces"] for p in f["points"]]
    assert max(xs) == 600.0 and max(ys) == 250.0
    assert "triangles" not in sample["faces"][0]
    assert model.expressions == {"W": "800 mm", "D": "W / 2", "d12": "18 mm"}


def test_교차_검증_샘플에서_하나라도_재계산이_실패하면_실패로_기록한다() -> None:
    model = FakeModel(failing_values={"D": {250.0}})

    sample = cross_check_sample(model, {"W": 600.0, "D": 250.0})

    assert sample["status"] == "recompute_failed"
    assert sample["faces"] == []
    assert model.expressions["D"] == "W / 2"


def test_교차_검증_샘플에_모델에_없는_파라미터가_있으면_아무것도_바꾸지_않고_거절한다() -> None:
    model = FakeModel()

    with pytest.raises(ValueError, match="H"):
        cross_check_sample(model, {"W": 600.0, "H": 500.0})

    assert model.set_calls == []


def test_업로드_뒤_추가_샘플_요청을_받으면_값_묶음마다_샘플과_같은_형식으로_답한다() -> None:
    model = FakeModel()
    server = FakeServer(requests=[{"id": "r1", "kind": "cross", "values": [{"W": 600.0, "D": 250.0}, {"W": 1000.0, "D": 500.0}]}])

    answered = serve_sample_request(model, server, "upload-1")

    assert answered is True
    assert [(upload_id, request_id) for upload_id, request_id, _ in server.answers] == [("upload-1", "r1")]
    response = server.answers[0][2]
    assert [s["values"] for s in response["samples"]] == [{"W": 600.0, "D": 250.0}, {"W": 1000.0, "D": 500.0}]
    assert max(p[0] for f in response["samples"][1]["faces"] for p in f["points"]) == 1000.0
    assert sample_response_errors([{"W": 600.0, "D": 250.0}, {"W": 1000.0, "D": 500.0}], response) == []
    assert model.expressions == {"W": "800 mm", "D": "W / 2", "d12": "18 mm"}


def test_기다리는_추가_샘플_요청이_없으면_모델을_건드리지_않는다() -> None:
    model = FakeModel()
    server = FakeServer()

    assert serve_sample_request(model, server, "upload-1") is False
    assert model.set_calls == []
    assert server.answers == []


class _BrokenModel(FakeModel):
    """D를 바꾸면 Fusion API가 예외를 내는 모델"""

    def set_parameter(self, name: str, value: float) -> bool:
        if name == "D":
            raise RuntimeError("Fusion API 오류")
        return super().set_parameter(name, value)


def test_교차_검증_샘플을_뽑다가_예외가_나도_바꾼_파라미터의_수식을_되돌린다() -> None:
    model = _BrokenModel()

    with pytest.raises(RuntimeError):
        cross_check_sample(model, {"W": 600.0, "D": 250.0})

    assert model.expressions == {"W": "800 mm", "D": "W / 2", "d12": "18 mm"}


def test_추가_샘플을_뽑지_못하면_답_대신_실패_이유를_서버에_알린다() -> None:
    server = FakeServer(requests=[{"id": "r1", "kind": "cross", "values": [{"W": 600.0, "H": 500.0}]}])

    assert serve_sample_request(FakeModel(), server, "upload-1") is True

    assert server.answers == []
    assert len(server.failures) == 1
    upload_id, request_id, reason = server.failures[0]
    assert (upload_id, request_id) == ("upload-1", "r1")
    assert "H" in reason
