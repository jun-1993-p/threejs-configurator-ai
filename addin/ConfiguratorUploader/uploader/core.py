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


def _changed_counts(point: dict[str, Any], baseline: Baseline) -> dict[str, list[float]]:
    """값이 바뀐 개수형 파라미터: [비교 대상 값, 그 지점 값]"""
    return {
        name: [baseline.counts[name], value]
        for name, value in point.get("counts", {}).items()
        if value != baseline.counts[name]
    }


def _reduction(side: str, point: dict[str, Any], baseline: Baseline, reason: str | None = None) -> dict[str, Any]:
    """면 구성이 바뀐 지점의 기록. 개수형 파라미터 값이 그대로면 모델링 오류 의심이다(ADR-0005).

    baseline은 그 지점 바로 안쪽의 면 구성이다(기본 형상 또는 안쪽 위상 묶음).
    """
    found, base = Composition.of(point), baseline.composition
    counts = _changed_counts(point, baseline)
    return {
        "side": side,
        "at": point["value"],
        # 개수형 값이 함께 바뀐 위상 변화는 범위 축소, 그대로면 모델링 오류 의심. 피드백 종류와 같은 이름이다.
        "reason": reason or ("range_shrunk" if counts else "modeling_error_suspected"),
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
    위상 묶음 안의 단독 스윕이 쓴다. 묶음 안에서 다시 묶음으로 나누지 않으므로, 개수형 값이 바뀐 지점에서도 줄인다.
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


def _coarse_points(
    model: FusionModel, parameter: ParameterInfo, counts: Sequence[str]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """기본값 ±50% 5점 샘플과 검증점(이웃 샘플 사이 가운데 값, ADR-0012). 파라미터는 되돌리지 않는다."""
    values = [parameter.value * factor for factor in SWEEP_FACTORS]
    samples = [_sample(model, parameter, value, counts) for value in values]
    checks = [_sample(model, parameter, (a + b) / 2, counts) for a, b in zip(values, values[1:])]
    return samples, checks


def _sweep_json(
    parameter: ParameterInfo,
    bounds: dict[str, float],
    samples: list[dict[str, Any]],
    checks: list[dict[str, Any]],
    reductions: list[dict[str, Any]],
) -> dict[str, Any]:
    """줄어든 범위 밖의 샘플·검증점은 담지 않는다. 바뀐 면 구성은 reductions에 남는다."""
    sweep: dict[str, Any] = {
        "parameter": parameter.name,
        "range": bounds,
        "samples": sorted((s for s in samples if bounds["min"] <= s["value"] <= bounds["max"]), key=lambda s: s["value"]),
        "checks": [c for c in checks if bounds["min"] <= c["value"] <= bounds["max"]],
    }
    if reductions:
        sweep["reductions"] = reductions
    return sweep


def _single_sweep(model: FusionModel, parameter: ParameterInfo, baseline: Baseline) -> dict[str, Any]:
    """위상 묶음으로 나누지 않는 단독 스윕: 면 구성이 바뀌면 그 앞에서 범위를 줄인다. 다른 파라미터는 지금 값 그대로다."""
    samples, checks = _coarse_points(model, parameter, list(baseline.counts))
    # 값이 아니라 원래 수식을 되돌린다. 수식으로 묶인 자식 관계를 상수로 덮지 않기 위해서다(ADR-0003).
    model.restore_parameter(parameter)
    bounds, reductions = _limit_range(parameter.value, samples, checks, baseline)
    return _sweep_json(parameter, bounds, samples, checks, reductions)


# 파라미터 하나의 위상 묶음 상한(기본 묶음 포함). 묶음마다 나머지 파라미터를 다시 스윕하기 때문이다(ADR-0005).
TOPOLOGY_GROUP_LIMIT = 4

# 위상 경계를 이 폭(파라미터 값) 안으로 좁힌다. 경계에서 형상이 바로 바뀌므로 치수 합격선(0.2 mm)과 같은 값을 쓴다.
BOUNDARY_TOLERANCE = 0.2


@dataclass
class _Group:
    """기본값에서 한쪽 끝으로 가며 면 구성이 같은 점들(위상 묶음 후보). 쪽마다 첫 묶음은 기본 묶음이다."""

    reference: Baseline
    # 기본값에서 먼 순서. 샘플과 검증점이 섞여 있다.
    points: list[dict[str, Any]]


@dataclass
class _Side:
    """기본값에서 한쪽 끝까지 나눈 위상 묶음과 그 사이 경계"""

    groups: list[_Group]
    # edges[k]: groups[k]와 groups[k + 1] 사이 경계 양쪽 점(안쪽, 바깥쪽)
    edges: list[tuple[dict[str, Any], dict[str, Any]]]
    # 개수형 값이 그대로인데 면 구성이 바뀐 점(모델링 오류 의심). 없으면 None
    stop: dict[str, Any] | None = None


def _bisect(
    model: FusionModel, parameter: ParameterInfo, inner: dict[str, Any], outer: dict[str, Any], reference: Baseline
) -> tuple[dict[str, Any], dict[str, Any]]:
    """안쪽 면 구성(reference)과 그 밖의 면 구성 사이 경계를 BOUNDARY_TOLERANCE 안으로 좁혀, 경계 양쪽 점을 돌려준다.

    inner·outer는 재계산에 성공한 점이다. 가운데 값에서 재계산이 실패하면 어느 쪽인지 알 수 없으므로 거기서 멈춘다.
    """
    counts = list(reference.counts)
    while abs(outer["value"] - inner["value"]) > BOUNDARY_TOLERANCE:
        sample = _sample(model, parameter, (inner["value"] + outer["value"]) / 2, counts)
        if sample["status"] != "ok":
            break
        if Composition.of(sample) == reference.composition:
            inner = sample
        else:
            outer = sample
    return inner, outer


def _split_side(
    model: FusionModel,
    parameter: ParameterInfo,
    origin: dict[str, Any],
    points: list[dict[str, Any]],
    baseline: Baseline,
    outward: int,
) -> _Side:
    """기본값(origin)에서 한쪽 끝으로 가며 면 구성이 바뀌는 곳마다 경계를 좁혀 위상 묶음을 나눈다(ADR-0005).

    경계 바깥쪽 점의 면 구성이 그 너머 점과 다르면(성긴 점 사이에 숨은 묶음) 그 점으로 묶음을 하나 열고 다시 좁힌다.
    개수형 값이 그대로인데 면 구성이 바뀌면 거기서 멈춘다.
    """
    pending = sorted(
        (p for p in points if p["status"] == "ok" and (p["value"] - origin["value"]) * outward > 0),
        key=lambda p: abs(p["value"] - origin["value"]),
    )
    side = _Side([_Group(baseline, [])], [])
    while pending:
        point, group = pending[0], side.groups[-1]
        if Composition.of(point) == group.reference.composition:
            group.points.append(pending.pop(0))
            continue
        if not _changed_counts(point, group.reference):
            side.stop = point
            break
        inner, outer = _bisect(model, parameter, group.points[-1] if group.points else origin, point, group.reference)
        if not _changed_counts(outer, group.reference):
            side.stop = outer
            break
        side.edges.append((inner, outer))
        # 바깥쪽 점으로 새 묶음을 연다. point는 다음 차례에 이 묶음과 다시 견준다.
        side.groups.append(_Group(Baseline(Composition.of(outer), dict(outer["counts"])), [outer]))
    return side


def _limit_groups(default: float, sides: dict[str, _Side]) -> dict[str, _Group]:
    """위상 묶음이 TOPOLOGY_GROUP_LIMIT를 넘으면 기본값에서 먼 묶음부터 뺀다. 쪽마다 뺀 묶음 가운데 가장 안쪽 것을 돌려준다."""
    dropped: dict[str, _Group] = {}
    while 1 + sum(len(s.groups) - 1 for s in sides.values()) > TOPOLOGY_GROUP_LIMIT:
        # 묶음에서 기본값에 가장 가까운 점의 거리로 잰다
        far = max(
            (name for name, s in sides.items() if len(s.groups) > 1),
            key=lambda name: abs(sides[name].groups[-1].points[0]["value"] - default),
        )
        dropped[far] = sides[far].groups.pop()
    return dropped


def _sweep(
    model: FusionModel, parameter: ParameterInfo, baseline: Baseline, others: Sequence[ParameterInfo]
) -> dict[str, Any]:
    """단독 스윕. 범위 안에서 개수형 값과 함께 면 구성이 바뀌면 위상 묶음으로 나누고(ADR-0005), 묶음마다
    나머지 파라미터(others)의 단독 스윕을 그 묶음의 기준 형상에서 뽑는다.

    범위가 줄어드는 까닭은 쪽마다 하나다: 묶음 상한(topology_group_limit), 모델링 오류 의심, 샘플이 2개보다 적어
    보간할 수 없는 묶음(range_shrunk). 줄어든 범위 밖의 묶음은 담지 않는다.
    """
    default = parameter.value

    def distance(value: float) -> float:
        return abs(value - default)

    samples, checks = _coarse_points(model, parameter, list(baseline.counts))
    bounds = {"min": samples[0]["value"], "max": samples[-1]["value"]}
    origin = next(s for s in samples if s["value"] == default)
    sides = {
        name: _split_side(model, parameter, origin, samples + checks, baseline, outward)
        for name, outward in (("min", -1), ("max", 1))
    }
    # 경계 양쪽 점을 샘플로 더한다. 검증점이 경계 끝이면 같은 값의 샘플이 된다(형상이 같다).
    for side in sides.values():
        for edge in (e for pair in side.edges for e in pair):
            if edge["value"] not in {s["value"] for s in samples}:
                samples.append(edge)
    dropped = _limit_groups(default, sides)

    reductions: dict[str, dict[str, Any]] = {}
    groups: list[tuple[_Group, list[dict[str, Any]]]] = []
    for name, outward in (("min", -1), ("max", 1)):
        side = sides[name]
        on_side = [s for s in samples if (s["value"] - default) * outward > 0]
        if name in dropped:
            bounds[name] = side.edges[len(side.groups) - 1][0]["value"]
            reductions[name] = _reduction(name, dropped[name].points[0], side.groups[-1].reference, "topology_group_limit")
        elif side.stop is not None:
            # 바뀐 지점 앞의 가장 먼 샘플. 없으면 기본값까지 줄어든다.
            inside = [s["value"] for s in on_side if distance(s["value"]) < distance(side.stop["value"])]
            bounds[name] = max(inside, key=distance, default=default)
            reductions[name] = _reduction(name, side.stop, side.groups[-1].reference)
        for k, group in enumerate(side.groups[1:], start=1):
            # 묶음의 샘플: 안쪽 경계 바깥쪽 점부터 다음 경계 안쪽 점(마지막 묶음은 범위 끝)까지
            lo = distance(side.edges[k - 1][1]["value"])
            hi = distance(side.edges[k][0]["value"] if k < len(side.groups) - 1 else bounds[name])
            members = [s for s in on_side if lo <= distance(s["value"]) <= hi]
            if len(members) < 2:
                # 보간할 수 없는 묶음은 만들지 않고 그 경계 앞에서 줄인다
                bounds[name] = side.edges[k - 1][0]["value"]
                reductions[name] = _reduction(name, group.points[0], side.groups[k - 1].reference)
                break
            groups.append((group, members))
    model.restore_parameter(parameter)

    sweep = _sweep_json(parameter, bounds, samples, checks, list(reductions.values()))
    if groups:
        sweep["groups"] = sorted(
            (_group_json(model, parameter, group, members, others) for group, members in groups),
            key=lambda g: g["range"]["min"],
        )
    return sweep


def _group_json(
    model: FusionModel,
    parameter: ParameterInfo,
    group: _Group,
    members: list[dict[str, Any]],
    others: Sequence[ParameterInfo],
) -> dict[str, Any]:
    """기본 묶음 밖의 위상 묶음: 범위, 기준 형상(연결 포함)과 부품, 기준 형상에서 뽑은 나머지 파라미터의 단독 스윕"""
    values = sorted(s["value"] for s in members)
    middle = (values[0] + values[-1]) / 2
    # 기준 형상: 묶음 가운데에 가장 가까운 샘플. 같으면 기본값에 가까운 쪽
    anchor = min(values, key=lambda v: (abs(v - middle), abs(v - parameter.value)))
    try:
        model.set_parameter(parameter.name, anchor)
        shape = _shape_json(model, baseline=True)
        reference = Baseline(Composition.of(shape), model.parameter_values(list(group.reference.counts)))
        return {
            "range": {"min": values[0], "max": values[-1]},
            "anchor": anchor,
            "counts": reference.counts,
            "parts": _parts(model.bodies(), shape["faces"]),
            "baseline": shape,
            "sweeps": [_single_sweep(model, other, reference) for other in others],
        }
    finally:
        model.restore_parameter(parameter)


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
        "sweeps": [_sweep(model, p, reference, [o for o in swept if o is not p]) for p in swept],
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
