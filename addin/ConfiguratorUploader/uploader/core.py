"""업로드 묶음을 만드는 애드인 핵심. Fusion API에 의존하지 않는다."""

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

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
    # 피처 기준 면 이름(ADR-0016). 업로드 묶음에 꼭 있어야 한다.
    name: str | None = None
    # 표면 정의. 이름으로 짝지은 면을 기하로 한 번 더 확인하는 데 쓴다.
    geometry: dict[str, Any] | None = None
    # 면의 연결(points 번호 세 개씩). 기본 형상의 것만 업로드 묶음에 담긴다.
    triangles: list[tuple[int, int, int]] | None = None


@dataclass(frozen=True)
class EdgeSample:
    body: str
    # 두 면 이름 쌍 "면A|면B". 같은 쌍이 여럿이면 "~순번"이 붙는다.
    name: str
    start: Point
    mid: Point
    end: Point


@dataclass(frozen=True)
class BodyMeasure:
    body: str
    volume: float
    bbox_min: Point
    bbox_max: Point


class FusionModel(Protocol):
    def parameters(self) -> list[ParameterInfo]: ...
    def bodies(self) -> list[BodyInfo]: ...
    def set_parameter(self, name: str, value: float) -> bool: ...
    def restore_parameter(self, parameter: ParameterInfo) -> None: ...
    def sample_faces(self, grid_n: int) -> list[FaceSample]: ...
    def sample_edges(self) -> list[EdgeSample]: ...


@runtime_checkable
class MeasuringModel(Protocol):
    """바디 측정값까지 주는 모델. 지금은 SolidCraft 합성 녹화본만 해당한다."""

    def measure_bodies(self) -> list[BodyMeasure]: ...


class ServerClient(Protocol):
    def ping(self) -> bool: ...
    def upload(self, bundle: dict[str, Any]) -> str: ...


SCHEMA_VERSION = 1

# 경계 맞춤 격자의 밀도 기준(ADR-0016). 점 간격은 어댑터가 이 값으로 정한다.
GRID_N = 9


def _parts(bodies: list[BodyInfo], faces: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """부품은 컴포넌트 단위, 컴포넌트가 없는 바디는 바디 단위다(ADR-0006)."""
    component_of = {b.name: b.component for b in bodies}
    parts: dict[str, dict[str, Any]] = {}
    for index, face in enumerate(faces):
        component = component_of[face["body"]]
        name, kind = (component, "component") if component is not None else (face["body"], "body")
        part = parts.setdefault(name, {"name": name, "kind": kind, "faces": []})
        part["faces"].append(index)
    return list(parts.values())


# 단독 스윕의 샘플 위치: 기본값에 곱하는 비율. 기본값 ±50% 범위를 5점 균등으로 나눈다(ADR-0007).
# 비선형 구간을 더 나누는 적응형 샘플과 재계산 실패에 따른 범위 축소는 티켓 05에서 한다.
SWEEP_FACTORS = (0.5, 0.75, 1.0, 1.25, 1.5)


def _face_json(face: FaceSample, with_triangles: bool) -> dict[str, Any]:
    out: dict[str, Any] = {"body": face.body, "surface": face.surface}
    if face.name is not None:
        out["name"] = face.name
    if face.geometry is not None:
        out["geometry"] = face.geometry
    out["points"] = [list(p) for p in face.points]
    if with_triangles and face.triangles is not None:
        out["triangles"] = [list(t) for t in face.triangles]
    return out


def _shape_json(model: FusionModel, baseline: bool = False) -> dict[str, Any]:
    """현재 형상의 면과 모서리, 모델이 주면 바디 측정값. 연결은 기본 형상에만 담는다."""
    shape: dict[str, Any] = {
        "faces": [_face_json(f, baseline) for f in model.sample_faces(GRID_N)],
        "edges": [
            {"body": e.body, "name": e.name, "start": list(e.start), "mid": list(e.mid), "end": list(e.end)}
            for e in model.sample_edges()
        ],
    }
    if isinstance(model, MeasuringModel):
        shape["bodies"] = [
            {"name": b.body, "volume": b.volume, "bbox": {"min": list(b.bbox_min), "max": list(b.bbox_max)}}
            for b in model.measure_bodies()
        ]
    return shape


def _sweep(model: FusionModel, parameter: ParameterInfo) -> dict[str, Any]:
    values = [parameter.value * factor for factor in SWEEP_FACTORS]
    samples = []
    for value in values:
        recomputed = model.set_parameter(parameter.name, value)
        shape = _shape_json(model) if recomputed else {"faces": [], "edges": []}
        samples.append({"value": value, "status": "ok" if recomputed else "recompute_failed", **shape})
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
    source: str = "fusion",
    extra_sweeps: Sequence[str] = (),
) -> str | None:
    """extra_sweeps: 사용자 파라미터가 아니어도 단독 스윕할 파라미터 이름(예: 이름 없는 스케치 치수)."""
    if not server.ping():
        notify("서버에 연결할 수 없습니다. 스윕을 시작하지 않았습니다.")
        return None
    parameters = model.parameters()
    baseline = _shape_json(model, baseline=True)
    bundle = {
        "schema_version": SCHEMA_VERSION,
        "units": "mm",
        "source": source,
        "grid": {"n": GRID_N},
        "parts": _parts(model.bodies(), baseline["faces"]),
        "baseline": baseline,
        "sweeps": [_sweep(model, p) for p in parameters if p.is_user or p.name in extra_sweeps],
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
