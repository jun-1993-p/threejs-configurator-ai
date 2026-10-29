from typing import Any

import pytest
from uploader.core import ParameterInfo, TopologyModel

from synthetic.solidcraft_model import SolidCraftModel, UnsupportedFaceError, edge_faces


class FakeCli:
    """solidcraft-cli 대신 명령 목록을 받아 결과를 돌려준다. 폭 w인 판 하나(평면 면 하나)."""

    def __init__(self, failing: set[float] | None = None, extra_face: dict[str, Any] | None = None) -> None:
        self.failing = failing or set()
        self.extra_face = extra_face
        self.scripts: list[list[dict[str, Any]]] = []

    def __call__(self, commands: list[dict[str, Any]]) -> list[Any]:
        self.scripts.append(commands)
        w = 200.0
        errors: list[str] = []
        for c in commands:
            if c["command"] == "parameters.change" and c["params"]["name"] == "w":
                w = float(c["params"]["expression"].split()[0])
                if w in self.failing:
                    errors.append("Plate: 재계산 실패")
        return [self._result(c, w, errors) for c in commands]

    def _result(self, c: dict[str, Any], w: float, errors: list[str]) -> Any:
        name = c["command"]
        if name == "parameters.list":
            return {
                "parameters": [
                    {"name": "w", "value": 200.0, "unit": "mm", "expression": "200 mm", "source": "user"},
                    {"name": "d3", "value": 20.0, "unit": "mm", "expression": "20", "source": "sketch"},
                ]
            }
        if name == "parameters.change":
            return {"name": c["params"]["name"], "errors": errors}
        if name == "document.inspect":
            return {"timeline": [{"name": "Plate", "error": errors[0] if errors else None}]}
        if name == "model.faces":
            # 윗면과, 윗면 모서리 너머의 옆면 네 개(모서리 이름이 가리키는 면은 모두 목록에 있다)
            sides = [(0.0, -1.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (-1.0, 0.0, 0.0)]
            faces = [{"name": "F1:+z", "plane_normal": [0.0, 0.0, 1.0]}] + [
                {"name": f"F1:s{i}", "plane_normal": list(n)} for i, n in enumerate(sides)
            ]
            if self.extra_face:
                faces.append(self.extra_face)
            return {"body": c["params"]["body"], "faces": faces}
        if name == "model.edges":
            corners = [(0.0, 0.0), (w, 0.0), (w, 100.0), (0.0, 100.0)]
            edges = []
            for i in range(4):
                (x0, y0), (x1, y1) = corners[i], corners[(i + 1) % 4]
                edges.append(
                    {
                        "name": f"F1:+z|F1:s{i}",
                        "start": [x0, y0, 20.0],
                        "mid": [(x0 + x1) / 2, (y0 + y1) / 2, 20.0],
                        "end": [x1, y1, 20.0],
                    }
                )
            return {"body": c["params"]["body"], "edges": edges}
        if name == "inspect.measure":
            return {
                "bodies": [
                    {"name": "Plate", "volume_mm3": w * 100 * 20, "bbox": {"min": [0, 0, 0], "max": [w, 100, 20]}}
                ]
            }
        raise AssertionError(name)


def test_파라미터와_바디를_SolidCraft에서_읽는다() -> None:
    model = SolidCraftModel(FakeCli())

    assert model.parameters() == [
        ParameterInfo(name="w", value=200.0, unit="mm", expression="200 mm", is_user=True),
        ParameterInfo(name="d3", value=20.0, unit="mm", expression="20", is_user=False),
    ]
    assert [(b.name, b.component) for b in model.bodies()] == [("Plate", None)]
    assert isinstance(model, TopologyModel)


def test_바꾼_파라미터를_매번_처음부터_다시_적용하고_되돌리면_빠진다() -> None:
    cli = FakeCli()
    model = SolidCraftModel(cli)
    w = model.parameters()[0]

    assert model.set_parameter("w", 300.0) is True
    model.restore_parameter(w)
    model.sample_faces(3)

    changes = [[c["params"] for c in s if c["command"] == "parameters.change"] for s in cli.scripts]
    assert {"name": "w", "expression": "300.0 mm"} in changes[1]
    assert changes[-1] == []


def test_피처_오류가_있으면_재계산_실패로_본다() -> None:
    model = SolidCraftModel(FakeCli(failing={100.0}))

    assert model.set_parameter("w", 100.0) is False
    assert model.set_parameter("w", 150.0) is True


def test_면_이름과_표면과_격자_점을_준다() -> None:
    model = SolidCraftModel(FakeCli())
    model.set_parameter("w", 400.0)

    face = model.sample_faces(3)[0]

    assert (face.body, face.surface, face.name) == ("Plate", "plane", "F1:+z")
    assert face.geometry == {"type": "plane", "normal": [0.0, 0.0, 1.0]}
    assert len(face.points) == 9
    assert max(p[0] for p in face.points) == pytest.approx(400.0)


def test_모서리와_바디_측정값을_준다() -> None:
    model = SolidCraftModel(FakeCli())

    edges = model.sample_edges()
    [measure] = model.measure_bodies()

    assert [e.name for e in edges] == [f"F1:+z|F1:s{i}" for i in range(4)]
    assert edges[0].body == "Plate" and edges[0].end == (200.0, 0.0, 20.0)
    assert measure.volume == 200.0 * 100 * 20
    assert measure.bbox_max == (200.0, 100.0, 20.0)


def test_평면과_원기둥이_아닌_면이_있으면_면_이름과_함께_오류를_낸다() -> None:
    model = SolidCraftModel(FakeCli(extra_face={"name": "F2:sphere", "sphere": {}}))

    with pytest.raises(UnsupportedFaceError, match="F2:sphere"):
        model.sample_faces(3)


def test_mm가_아닌_단위의_파라미터는_바꾸지_않는다() -> None:
    model = SolidCraftModel(FakeCli())
    model._parameters.append(ParameterInfo(name="a", value=1.0, unit="deg", expression="1 deg", is_user=True))

    with pytest.raises(ValueError, match="deg"):
        model.set_parameter("a", 2.0)


def test_면_이름에_세로선이_있어도_모서리를_두_면으로_나눈다() -> None:
    names = {"F1:-z", "F1:-x", "F3:blend:F1:-x|F1:-y", "F2:bore:side:0", "F2:bore:side:1"}

    assert edge_faces("F1:-z|F3:blend:F1:-x|F1:-y", names) == ("F1:-z", "F3:blend:F1:-x|F1:-y")
    assert edge_faces("F3:blend:F1:-x|F1:-y|F1:-x", names) == ("F3:blend:F1:-x|F1:-y", "F1:-x")
    assert edge_faces("F2:bore:side:0|F2:bore:side:1~2", names) == ("F2:bore:side:0", "F2:bore:side:1")
