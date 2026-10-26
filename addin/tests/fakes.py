"""Fusion 어댑터와 서버의 가짜 구현. 실제 Fusion 없이 애드인 핵심을 시험한다."""

from typing import Any

from uploader.core import BodyInfo, FaceSample, ParameterInfo


class FakeModel:
    """폭 W·깊이 D를 사용자 파라미터로 갖는 단순한 모델. 바디마다 평면 하나를 갖는다."""

    def __init__(
        self,
        parameters: list[ParameterInfo] | None = None,
        bodies: list[BodyInfo] | None = None,
        failing_values: dict[str, set[float]] | None = None,
    ) -> None:
        self._parameters = parameters or [
            ParameterInfo(name="W", value=800.0, unit="mm", expression="800 mm", is_user=True),
            ParameterInfo(name="D", value=400.0, unit="mm", expression="W / 2", is_user=True),
            ParameterInfo(name="d12", value=18.0, unit="mm", expression="18 mm", is_user=False),
        ]
        self._bodies = bodies or [
            BodyInfo(name="Body1", component="상판"),
            BodyInfo(name="Body2", component="상판"),
            BodyInfo(name="Body3", component="측판"),
        ]
        self._failing = failing_values or {}
        self.values = {p.name: p.value for p in self._parameters}
        self.expressions = {p.name: p.expression for p in self._parameters}
        self.set_calls: list[tuple[str, float]] = []

    def parameters(self) -> list[ParameterInfo]:
        return list(self._parameters)

    def bodies(self) -> list[BodyInfo]:
        return list(self._bodies)

    def set_parameter(self, name: str, value: float) -> bool:
        self.set_calls.append((name, value))
        self.values[name] = value
        self.expressions[name] = f"{value}"
        return value not in self._failing.get(name, set())

    def restore_parameter(self, parameter: ParameterInfo) -> None:
        self.values[parameter.name] = parameter.value
        self.expressions[parameter.name] = parameter.expression

    def sample_faces(self, grid_n: int) -> list[FaceSample]:
        w, d = self.values["W"], self.values["D"]
        samples = []
        for index, body in enumerate(self._bodies):
            z = 18.0 * index
            points = [
                (w * i / (grid_n - 1), d * j / (grid_n - 1), z)
                for i in range(grid_n)
                for j in range(grid_n)
            ]
            samples.append(FaceSample(body=body.name, surface="plane", points=points))
        return samples


class FakeServer:
    def __init__(self, reachable: bool = True) -> None:
        self.reachable = reachable
        self.uploaded: list[dict[str, Any]] = []

    def ping(self) -> bool:
        return self.reachable

    def upload(self, bundle: dict[str, Any]) -> str:
        self.uploaded.append(bundle)
        return f"upload-{len(self.uploaded)}"
