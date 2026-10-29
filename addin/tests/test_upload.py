import json
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import jsonschema
import pytest
from fakes import FakeModel, FakeServer, FakeMeasuringModel
from server.bundle import sample_response_errors
from uploader.core import BodyInfo, EdgeSample, FaceSample, ParameterInfo, cross_check_sample, run_upload, serve_sample_request

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


def test_업로드_묶음에_파라미터마다_이름_값_수식_사용자_파라미터_여부_개수형_여부가_담긴다() -> None:
    server = FakeServer()

    upload_id = run_upload(FakeModel(), server, lambda _: None)

    assert upload_id == "upload-1"
    assert server.uploaded[0]["parameters"] == [
        {"name": "W", "value": 800.0, "unit": "mm", "expression": "800 mm", "is_user": True, "is_count": False},
        {"name": "D", "value": 400.0, "unit": "mm", "expression": "W / 2", "is_user": True, "is_count": False},
        {"name": "d12", "value": 18.0, "unit": "mm", "expression": "18 mm", "is_user": False, "is_count": False},
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


class _ShelfModel(FakeModel):
    """폭 W가 1100 이상이면 선반 수(개수형 자식 shelves)가 2에서 3이 되고 선반 면이 하나 늘어나는 모델."""

    def __init__(self, count_user: bool = False) -> None:
        super().__init__(
            parameters=[
                ParameterInfo(name="W", value=800.0, unit="mm", expression="800 mm", is_user=True),
                ParameterInfo(name="D", value=400.0, unit="mm", expression="400 mm", is_user=True),
                ParameterInfo(name="shelves", value=2.0, unit="", expression="W >= 1100 ? 3 : 2", is_user=count_user),
            ]
        )

    def _follow(self) -> None:
        self.values["shelves"] = 3.0 if self.values["W"] >= 1100 else 2.0

    def set_parameter(self, name: str, value: float) -> bool:
        ok = super().set_parameter(name, value)
        self._follow()
        return ok

    def restore_parameter(self, parameter: ParameterInfo) -> None:
        super().restore_parameter(parameter)
        self._follow()

    def sample_faces(self, grid_n: int) -> list[FaceSample]:
        faces = super().sample_faces(grid_n)
        if self.values["shelves"] != 2:
            faces.append(replace(faces[0], name="F2:shelf"))
        return faces


def run_upload_bundle(model: FakeModel) -> dict[str, Any]:
    server = FakeServer()
    run_upload(model, server, lambda _: None)
    return server.uploaded[0]


def test_단위가_없는_정수_파라미터는_개수형으로_담기고_사용자_파라미터여도_스윕하지_않는다() -> None:
    server = FakeServer()

    run_upload(_ShelfModel(count_user=True), server, lambda _: None)

    bundle = server.uploaded[0]
    assert [(p["name"], p["is_count"]) for p in bundle["parameters"]] == [("W", False), ("D", False), ("shelves", True)]
    assert [s["parameter"] for s in bundle["sweeps"]] == ["W", "D"]


def test_개수형_파라미터가_있으면_샘플마다_그_값을_담는다() -> None:
    d = run_upload_bundle(_ShelfModel())["sweeps"][1]

    assert [s["counts"] for s in d["samples"]] == [{"shelves": 2.0}] * 5
    assert "counts" not in run_upload_bundle(FakeModel())["sweeps"][0]["samples"][0]


def test_면_구성이_바뀌지_않으면_범위를_줄이지_않는다() -> None:
    w = run_upload_bundle(FakeModel())["sweeps"][0]

    assert w["range"] == {"min": 400.0, "max": 1200.0}
    assert "reductions" not in w


def test_범위_안에서_개수형_값과_함께_면_구성이_바뀌면_범위를_줄이지_않고_위상_묶음으로_나눈다() -> None:
    # 검증점 1100에서 선반 수가 3이 된다. 경계(1100)를 0.2 안으로 좁혀 양쪽에 샘플을 더한다.
    w = run_upload_bundle(_ShelfModel())["sweeps"][0]

    assert w["range"] == {"min": 400.0, "max": 1200.0}
    assert "reductions" not in w
    values = [s["value"] for s in w["samples"]]
    assert values[:4] == [400.0, 600.0, 800.0, 1000.0] and values[-2:] == [1100.0, 1200.0]
    [edge] = values[4:-2]
    assert 1099.8 <= edge < 1100.0
    assert [c["value"] for c in w["checks"]] == [500.0, 700.0, 900.0, 1100.0]
    [group] = w["groups"]
    assert group["range"] == {"min": 1100.0, "max": 1200.0}
    assert group["counts"] == {"shelves": 3.0}
    # 기준 형상: 묶음 가운데(1150)에 가장 가까운 샘플, 같으면 기본값에 가까운 쪽
    assert group["anchor"] == 1100.0
    assert {(f["body"], f["name"]) for f in group["baseline"]["faces"]} >= {("Body1", "F2:shelf")}
    assert all("triangles" in f for f in group["baseline"]["faces"])
    assert [p["name"] for p in group["parts"]] == ["상판", "측판"]


def test_위상_묶음마다_나머지_파라미터의_단독_스윕을_그_묶음의_기준_형상에서_뽑는다() -> None:
    model = _ShelfModel()
    server = FakeServer()
    run_upload(model, server, lambda _: None)

    [group] = server.uploaded[0]["sweeps"][0]["groups"]
    [d] = group["sweeps"]
    assert d["parameter"] == "D"
    assert [s["value"] for s in d["samples"]] == [200.0, 300.0, 400.0, 500.0, 600.0]
    # 묶음 안의 단독 스윕은 W를 기준 형상 값(1100)에 둔 형상이다
    assert all(len(f["points"]) == 81 and f["points"][-1][0] == 1100.0 for s in d["samples"] for f in s["faces"])
    assert [s["counts"] for s in d["samples"]] == [{"shelves": 3.0}] * 5
    assert model.values == {"W": 800.0, "D": 400.0, "shelves": 2.0}
    assert model.expressions["W"] == "800 mm"


def test_파라미터_하나의_위상_묶음이_4개를_넘으면_기본값에서_먼_묶음부터_빼고_범위를_줄인다() -> None:
    class _Bays(_ShelfModel):
        """칸 수 = floor(W / 220): W 400~1200에서 1·2·3·4·5칸, 기본값 800은 3칸이다."""

        def __init__(self) -> None:
            super().__init__()
            self._parameters[2] = replace(self._parameters[2], value=3.0, expression="floor(W / 220 mm)")
            self._follow()

        def _follow(self) -> None:
            self.values["shelves"] = float(self.values["W"] // 220)

        def sample_faces(self, grid_n: int) -> list[FaceSample]:
            faces = FakeModel.sample_faces(self, grid_n)
            return faces + [replace(faces[0], name=f"F2:bay{k}") for k in range(int(self.values["shelves"]))]

    w = run_upload_bundle(_Bays())["sweeps"][0]

    # 기본값에서 가장 먼 1칸 묶음(400)을 빼서 묶음이 4개(기본 묶음 포함)가 된다
    assert [g["counts"] for g in w["groups"]] == [{"shelves": 2.0}, {"shelves": 4.0}, {"shelves": 5.0}]
    # 1칸·2칸 경계는 440이다(440은 2칸)
    assert 440.0 <= w["range"]["min"] <= 440.2 and w["range"]["max"] == 1200.0
    [reduction] = w["reductions"]
    # 뺀 묶음에서 기본값에 가장 가까운 점: 1칸·2칸 경계 바로 바깥
    assert reduction["side"] == "min" and 439.8 <= reduction["at"] < 440.0
    assert reduction["reason"] == "topology_group_limit"
    assert reduction["counts"] == {"shelves": [2.0, 1.0]}
    assert all(s["value"] >= w["range"]["min"] for s in w["samples"] + w["checks"])


def test_개수형_값이_그대로인데_면_구성이_바뀌면_모델링_오류_의심으로_범위를_줄인다() -> None:
    class _LostFace(_ShelfModel):
        """깊이 D가 250보다 작으면 선반 수와 상관없이 면 하나가 사라진다(속 비우기 면 지정점이 면 밖으로 나간 모델처럼)."""

        def sample_faces(self, grid_n: int) -> list[FaceSample]:
            faces = super().sample_faces(grid_n)
            return faces[:-1] if self.values["D"] < 250 else faces

    d = run_upload_bundle(_LostFace())["sweeps"][1]

    assert d["range"] == {"min": 300.0, "max": 600.0}
    assert d["reductions"] == [
        {
            "side": "min",
            "at": 200.0,
            "reason": "modeling_error_suspected",
            "removed_faces": [{"body": "Body3", "name": "F1:top"}],
            "added_faces": [],
            "removed_edges": [],
            "added_edges": [],
            "counts": {},
        }
    ]


def test_개수형_파라미터가_없는_모델에서_면_구성이_바뀌면_모델링_오류_의심이다() -> None:
    class _LostFace(FakeModel):
        def sample_faces(self, grid_n: int) -> list[FaceSample]:
            faces = super().sample_faces(grid_n)
            return faces[:-1] if self.values["W"] < 500 else faces

    w = run_upload_bundle(_LostFace())["sweeps"][0]

    assert w["range"] == {"min": 600.0, "max": 1200.0}
    assert [r["reason"] for r in w["reductions"]] == ["modeling_error_suspected"]


def test_면_이름이_그대로여도_모서리가_바뀌면_면_구성이_바뀐_것으로_보고_범위를_줄인다() -> None:
    class _SplitEdge(FakeModel):
        """W가 1100 이상이면 Body1의 모서리가 둘로 나뉜다(경계가 나뉘어 꼭짓점 짝이 깨진다)."""

        def sample_edges(self) -> list[EdgeSample]:
            edges = super().sample_edges()
            if self.values["W"] >= 1100:
                edges[0] = replace(edges[0], name="F1:top|F1:side~1")
            return edges

    w = run_upload_bundle(_SplitEdge())["sweeps"][0]

    assert w["range"] == {"min": 400.0, "max": 1000.0}
    [reduction] = w["reductions"]
    assert reduction["removed_edges"] == [{"body": "Body1", "name": "F1:top|F1:side"}]
    assert reduction["added_edges"] == [{"body": "Body1", "name": "F1:top|F1:side~1"}]
    assert reduction["removed_faces"] == [] and reduction["added_faces"] == []


def test_범위를_줄인_업로드_묶음도_스키마를_통과한다() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    jsonschema.validate(run_upload_bundle(_ShelfModel(count_user=True)), schema)


class _Shelves(_ShelfModel):
    """선반 수를 W로 정하는 모델. 선반마다 면이 하나씩 있어 선반 수마다 면 구성이 다르다."""

    def __init__(self, shelves: Callable[[float], float]) -> None:
        self._shelves = shelves
        super().__init__()
        self._parameters[2] = replace(self._parameters[2], value=shelves(800.0))
        self._follow()

    def _follow(self) -> None:
        self.values["shelves"] = self._shelves(self.values["W"])

    def sample_faces(self, grid_n: int) -> list[FaceSample]:
        faces = FakeModel.sample_faces(self, grid_n)
        return faces + [replace(faces[0], name=f"F2:shelf{k}") for k in range(int(self.values["shelves"]))]


def test_성긴_샘플_사이에_숨은_위상_묶음도_경계를_좁히며_찾아_나눈다() -> None:
    # 선반 수가 1050에서 3, 1080에서 4가 된다. 성긴 점(1000, 검증점 1100)에는 3이 보이지 않는다.
    w = run_upload_bundle(_Shelves(lambda v: 2.0 if v < 1050 else 3.0 if v < 1080 else 4.0))["sweeps"][0]

    assert [g["counts"] for g in w["groups"]] == [{"shelves": 3.0}, {"shelves": 4.0}]
    three, four = w["groups"]
    assert 1049.8 <= three["range"]["min"] <= 1050.2 and 1079.8 <= three["range"]["max"] < 1080.0
    assert 1080.0 <= four["range"]["min"] <= 1080.2 and four["range"]["max"] == 1200.0


def test_위상_경계_바로_뒤에서_모델링_오류가_의심되면_샘플이_하나뿐인_묶음을_만들지_않고_경계_앞에서_줄인다() -> None:
    class _LostAfter(_ShelfModel):
        """1100에서 선반이 3이 되고, 1150부터는 선반 수와 상관없이 면 하나가 사라진다."""

        def sample_faces(self, grid_n: int) -> list[FaceSample]:
            faces = super().sample_faces(grid_n)
            return faces[1:] if self.values["W"] >= 1150 else faces

    w = run_upload_bundle(_LostAfter())["sweeps"][0]

    assert "groups" not in w
    assert 1099.8 <= w["range"]["max"] < 1100.0
    [reduction] = w["reductions"]
    assert (reduction["side"], reduction["at"], reduction["reason"]) == ("max", 1100.0, "range_shrunk")
    assert reduction["counts"] == {"shelves": [2.0, 3.0]}


def test_경계를_좁히다_재계산이_실패하면_거기서_멈추고_경계를_안쪽으로_당기지_않는다() -> None:
    model = _ShelfModel()
    model._failing = {"W": {1050.0}}

    w = run_upload_bundle(model)["sweeps"][0]

    [group] = w["groups"]
    assert group["range"]["min"] == 1100.0
    assert max(s["value"] for s in w["samples"] if s["value"] < 1100.0) == 1000.0
