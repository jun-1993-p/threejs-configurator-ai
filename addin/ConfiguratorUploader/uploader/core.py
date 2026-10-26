"""업로드 묶음을 만드는 애드인 핵심. Fusion API에 의존하지 않는다."""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

Point = tuple[float, float, float]


@dataclass(frozen=True)
class ParameterInfo:
    name: str
    value: float
    unit: str
    expression: str
    is_user: bool


@dataclass(frozen=True)
class BodyInfo:
    name: str
    # 바디가 속한 컴포넌트 이름. 루트 컴포넌트에 바로 있는 바디는 None.
    component: str | None


@dataclass(frozen=True)
class FaceSample:
    body: str
    surface: str
    points: list[Point]


class FusionModel(Protocol):
    def parameters(self) -> list[ParameterInfo]: ...
    def bodies(self) -> list[BodyInfo]: ...
    def set_parameter(self, name: str, value: float) -> bool: ...
    def restore_parameter(self, parameter: ParameterInfo) -> None: ...
    def sample_faces(self, grid_n: int) -> list[FaceSample]: ...


class ServerClient(Protocol):
    def ping(self) -> bool: ...
    def upload(self, bundle: dict[str, Any]) -> str: ...


SCHEMA_VERSION = 1

# 면마다 찍는 (u,v) 격자의 한 변 점 수. 면별 밀도 규칙은 나중에 정한다(ADR-0002).
GRID_N = 9


def _parts(bodies: list[BodyInfo], faces: list[FaceSample]) -> list[dict[str, Any]]:
    """부품은 컴포넌트 단위, 컴포넌트가 없는 바디는 바디 단위다(ADR-0006)."""
    component_of = {b.name: b.component for b in bodies}
    parts: dict[str, dict[str, Any]] = {}
    for index, face in enumerate(faces):
        component = component_of[face.body]
        name, kind = (component, "component") if component is not None else (face.body, "body")
        part = parts.setdefault(name, {"name": name, "kind": kind, "faces": []})
        part["faces"].append(index)
    return list(parts.values())


# 단독 스윕의 샘플 위치: 기본값에 곱하는 비율. 기본값 ±50% 범위를 5점 균등으로 나눈다(ADR-0007).
# 비선형 구간을 더 나누는 적응형 샘플과 재계산 실패에 따른 범위 축소는 티켓 05에서 한다.
SWEEP_FACTORS = (0.5, 0.75, 1.0, 1.25, 1.5)


def _faces_json(faces: list[FaceSample]) -> list[dict[str, Any]]:
    return [
        {"body": f.body, "surface": f.surface, "points": [list(p) for p in f.points]}
        for f in faces
    ]


def _sweep(model: FusionModel, parameter: ParameterInfo) -> dict[str, Any]:
    values = [parameter.value * factor for factor in SWEEP_FACTORS]
    samples = []
    for value in values:
        recomputed = model.set_parameter(parameter.name, value)
        samples.append(
            {
                "value": value,
                "status": "ok" if recomputed else "recompute_failed",
                "faces": _faces_json(model.sample_faces(GRID_N)) if recomputed else [],
            }
        )
    # 값이 아니라 원래 수식을 되돌린다. 수식으로 묶인 자식 관계를 상수로 덮지 않기 위해서다(ADR-0003).
    model.restore_parameter(parameter)
    return {
        "parameter": parameter.name,
        "range": {"min": values[0], "max": values[-1]},
        "samples": samples,
    }


def run_upload(
    model: FusionModel,
    server: ServerClient,
    notify: Callable[[str], None],
) -> str | None:
    if not server.ping():
        notify("서버에 연결할 수 없습니다. 스윕을 시작하지 않았습니다.")
        return None
    parameters = model.parameters()
    baseline = model.sample_faces(GRID_N)
    bundle = {
        "schema_version": SCHEMA_VERSION,
        "units": "mm",
        "grid": {"n": GRID_N},
        "parts": _parts(model.bodies(), baseline),
        "baseline": {"faces": _faces_json(baseline)},
        "sweeps": [_sweep(model, p) for p in parameters if p.is_user],
        "parameters": [
            {
                "name": p.name,
                "value": p.value,
                "unit": p.unit,
                "expression": p.expression,
                "is_user": p.is_user,
            }
            for p in parameters
        ],
    }
    return server.upload(bundle)
