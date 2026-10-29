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
    def parameter_values(self, names: Sequence[str]) -> dict[str, float]:
        """지금(바꾼 파라미터를 반영한) 값. 수식으로 따라가는 자식 파라미터 값도 준다."""
        ...


@runtime_checkable
class MeasuringModel(Protocol):
    """바디 측정값까지 주는 모델. 지금은 SolidCraft 합성 녹화본만 해당한다."""

    def measure_bodies(self) -> list[BodyMeasure]: ...


class ServerClient(Protocol):
    def ping(self) -> bool: ...
    def upload(self, bundle: dict[str, Any]) -> str: ...


class SampleRequestClient(Protocol):
    """업로드 뒤 추가 샘플 요청을 주고받는 서버 연결(ADR-0013)."""

    def next_sample_request(self, upload_id: str) -> dict[str, Any] | None: ...
    def answer_sample_request(self, upload_id: str, request_id: str, response: dict[str, Any]) -> None: ...
    def fail_sample_request(self, upload_id: str, request_id: str, reason: str) -> None: ...


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


def is_count(parameter: ParameterInfo) -> bool:
    """개수형 파라미터: 단위가 없고 값이 정수인 파라미터(선반 수, 패턴 개수). 스윕하지 않는다(ADR-0005)."""
    return parameter.unit == "" and float(parameter.value).is_integer()


@dataclass(frozen=True)
class Composition:
    """B-rep 면 구성: 면(바디, 면 이름, 표면 종류)과 모서리(바디, 모서리 이름). 샘플의 faces·edges가 그 기록이다.

    모서리까지 보는 것은 면 이름이 그대로여도 경계가 나뉘거나 합쳐지면 꼭짓점 짝이 깨지기 때문이다.
    """

    faces: frozenset[tuple[str, str, str]]
    edges: frozenset[tuple[str, str]]

    @staticmethod
    def of(shape: dict[str, Any]) -> "Composition":
        return Composition(
            faces=frozenset((f["body"], f["name"], f["surface"]) for f in shape["faces"]),
            edges=frozenset((e["body"], e["name"]) for e in shape["edges"]),
        )


@dataclass(frozen=True)
class Baseline:
    """범위 축소가 비교하는 기본 형상: 면 구성과 개수형 파라미터 값"""

    composition: Composition
    counts: dict[str, float]


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


def _shape_or_failure(model: FusionModel, recomputed: bool) -> dict[str, Any]:
    """샘플의 재계산 상태와 형상. 재계산에 실패하면 형상은 비운다."""
    shape = _shape_json(model) if recomputed else {"faces": [], "edges": []}
    return {"status": "ok" if recomputed else "recompute_failed", **shape}


def _sample(model: FusionModel, parameter: ParameterInfo, value: float, counts: Sequence[str]) -> dict[str, Any]:
    """단독 스윕 샘플. 개수형 파라미터가 있으면 그 값도 담는다(위상이 바뀐 까닭을 가리는 데 쓴다)."""
    sample = {"value": value, **_shape_or_failure(model, model.set_parameter(parameter.name, value))}
    if counts:
        sample["counts"] = model.parameter_values(counts)
    return sample


def cross_check_sample(model: FusionModel, values: dict[str, float]) -> dict[str, Any]:
    """교차 검증 샘플: 여러 파라미터를 함께 바꾼 형상. 형식은 단독 스윕 샘플과 같고 value 대신 values를 담는다.

    다 뽑으면 바꾼 파라미터의 원래 수식을 되돌린다(ADR-0003).
    """
    parameters = {p.name: p for p in model.parameters()}
    unknown = [name for name in values if name not in parameters]
    if unknown:
        raise ValueError(f"모델에 없는 파라미터: {', '.join(unknown)}")
    try:
        # 모두 바꾼 뒤에 재계산 결과를 본다. 앞에서 실패해도 나머지를 마저 바꿔야 되돌릴 목록이 맞는다.
        recomputed = all([model.set_parameter(name, value) for name, value in values.items()])
        return {"values": dict(values), **_shape_or_failure(model, recomputed)}
    finally:
        # 업로드 뒤에도 사용자가 연 모델이므로, 예외가 나도 수식을 되돌린다.
        for name in values:
            model.restore_parameter(parameters[name])


def serve_sample_request(model: FusionModel, server: SampleRequestClient, upload_id: str) -> bool:
    """서버가 기다리는 추가 샘플 요청 하나에 답한다(ADR-0013). 요청이 없으면 False.

    요청은 {id, kind, values: [{파라미터: 값}]}이고, 응답은 값 묶음마다 교차 검증 샘플 형식으로 같은 순서다.
    샘플을 뽑지 못하면(모델에 없는 파라미터, Fusion API 오류) 답 대신 실패 이유를 알린다. 파이프라인이 끝없이 기다리지 않게 하기 위해서다.
    """
    request = server.next_sample_request(upload_id)
    if request is None:
        return False
    try:
        samples = [cross_check_sample(model, values) for values in request["values"]]
    except Exception as error:
        server.fail_sample_request(upload_id, request["id"], f"{type(error).__name__}: {error}")
        return True
    server.answer_sample_request(upload_id, request["id"], {"samples": samples})
    return True


def _refs(keys: frozenset[tuple[str, ...]]) -> list[dict[str, str]]:
    return [{"body": key[0], "name": key[1]} for key in sorted(keys)]


def _reduction(side: str, point: dict[str, Any], baseline: Baseline) -> dict[str, Any]:
    """면 구성이 바뀐 지점의 기록. 개수형 파라미터 값이 그대로면 모델링 오류 의심이다(ADR-0005)."""
    found, base = Composition.of(point), baseline.composition
    counts = {
        name: [baseline.counts[name], value]
        for name, value in point.get("counts", {}).items()
        if value != baseline.counts[name]
    }
    return {
        "side": side,
        "at": point["value"],
        # 개수형 값이 함께 바뀐 위상 변화는 범위 축소, 그대로면 모델링 오류 의심. 피드백 종류와 같은 이름이다.
        "reason": "range_shrunk" if counts else "modeling_error_suspected",
        "removed_faces": _refs(base.faces - found.faces),
        "added_faces": _refs(found.faces - base.faces),
        "removed_edges": _refs(base.edges - found.edges),
        "added_edges": _refs(found.edges - base.edges),
        "counts": counts,
    }


def _limit_range(
    default: float, samples: list[dict[str, Any]], checks: list[dict[str, Any]], baseline: Baseline
) -> tuple[dict[str, float], list[dict[str, Any]]]:
    """기본값에서 범위 끝 쪽으로 가며 면 구성이 처음 바뀌는 지점을 찾아, 그 앞 샘플까지로 범위를 줄인다.

    샘플과 검증점을 함께 본다. 범위 끝은 보간할 수 있도록 샘플 값이어야 한다. 재계산 실패는 건너뛴다(티켓 05).
    범위 안의 위상 경계를 위상 묶음으로 나누는 일은 티켓 11에서 한다. 그때까지는 개수형 값이 바뀐 지점에서도 줄인다.
    """
    bounds = {"min": samples[0]["value"], "max": samples[-1]["value"]}
    reductions = []
    for side, outward in (("min", -1), ("max", 1)):
        points = sorted(
            (p for p in samples + checks if (p["value"] - default) * outward > 0),
            key=lambda p: abs(p["value"] - default),
        )
        changed = next(
            (p for p in points if p["status"] == "ok" and Composition.of(p) != baseline.composition), None
        )
        if changed is None:
            continue
        # 기본값과 바뀐 지점 사이에서 가장 먼 샘플. 없으면 기본값까지 줄어든다.
        inside = [s["value"] for s in samples if 0 <= (s["value"] - default) * outward < abs(changed["value"] - default)]
        bounds[side] = max(inside, key=lambda v: abs(v - default), default=default)
        reductions.append(_reduction(side, changed, baseline))
    return bounds, reductions


def _sweep(model: FusionModel, parameter: ParameterInfo, baseline: Baseline) -> dict[str, Any]:
    counts = list(baseline.counts)
    values = [parameter.value * factor for factor in SWEEP_FACTORS]
    samples = [_sample(model, parameter, value, counts) for value in values]
    # 검증점: 이웃 샘플 사이 가운데 값. 수치 검증이 이 형상과 변형 결과를 비교한다(ADR-0012).
    checks = [_sample(model, parameter, (a + b) / 2, counts) for a, b in zip(values, values[1:])]
    # 값이 아니라 원래 수식을 되돌린다. 수식으로 묶인 자식 관계를 상수로 덮지 않기 위해서다(ADR-0003).
    model.restore_parameter(parameter)
    bounds, reductions = _limit_range(parameter.value, samples, checks, baseline)
    # 줄어든 범위 밖의 샘플·검증점은 담지 않는다. 바뀐 면 구성은 reductions에 남는다.
    sweep: dict[str, Any] = {
        "parameter": parameter.name,
        "range": bounds,
        "samples": [s for s in samples if bounds["min"] <= s["value"] <= bounds["max"]],
        "checks": [c for c in checks if bounds["min"] <= c["value"] <= bounds["max"]],
    }
    if reductions:
        sweep["reductions"] = reductions
    return sweep


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
    # 개수형 파라미터(자식 포함)는 스윕하지 않고, 샘플마다 값을 적어 위상이 바뀐 까닭을 가린다.
    reference = Baseline(Composition.of(baseline), {p.name: p.value for p in parameters if is_count(p)})
    swept = [p for p in parameters if (p.is_user or p.name in extra_sweeps) and not is_count(p)]
    bundle = {
        "schema_version": SCHEMA_VERSION,
        "units": "mm",
        "source": source,
        "grid": {"n": GRID_N},
        "parts": _parts(model.bodies(), baseline["faces"]),
        "baseline": baseline,
        "sweeps": [_sweep(model, p, reference) for p in swept],
        "parameters": [
            {
                "name": p.name,
                "value": p.value,
                "unit": p.unit,
                "expression": p.expression,
                "is_user": p.is_user,
                "is_count": is_count(p),
            }
            for p in parameters
        ],
    }
    return server.upload(bundle)
