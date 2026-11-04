"""업로드 묶음을 만드는 애드인 핵심. Fusion API에 의존하지 않는다."""

import math
import re
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


# 단독 스윕의 처음 샘플 위치: 기본값에 곱하는 비율. 기본값 ±50% 범위를 5점 균등으로 나눈다(ADR-0007).
# 비선형 구간은 _adaptive_points가 더 나눈다.
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

    샘플과 검증점을 함께 본다. 범위 끝은 보간할 수 있도록 샘플 값이어야 한다. 재계산 실패 지점 밖은 이미 지웠다(_adaptive_points).
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


# 적응형 스윕(ADR-0007)의 샘플 상한(ADR-0012). 5점에서 구간을 두 번 다 반으로 나눈 수다.
SAMPLE_LIMIT = 17

# 합격선(ADR-0012): 치수 오차는 0.2 mm, 형상 오차는 1 mm와 상품 전체 바운딩 박스 대각선의 0.1% 중 큰 값.
# 수치 검증(configurator/pipeline/verify-numeric.ts)과 같은 값이다.
DIMENSION_TOLERANCE = 0.2


def _shape_tolerance(points: list[Point]) -> float:
    diagonal = math.dist([min(p[k] for p in points) for k in range(3)], [max(p[k] for p in points) for k in range(3)])
    return max(1.0, diagonal * 0.001)


@dataclass(frozen=True)
class _Miss:
    """검증점 하나에서 보간이 빗나간 양: 오차 종류(검증 피드백 종류와 같은 이름), 부품, 오차와 합격선(mm)"""

    kind: str
    part: str
    error: float
    tolerance: float

    @property
    def ratio(self) -> float:
        return self.error / self.tolerance

    def failure_json(self, at: float) -> dict[str, Any]:
        """업로드 묶음의 interpolation_failure"""
        return {"at": at, "kind": self.kind, "part": self.part, "error": self.error, "tolerance": self.tolerance}


def _interpolation_error(
    lo: dict[str, Any], hi: dict[str, Any], check: dict[str, Any], part_of: dict[str, str]
) -> _Miss | None:
    """검증점에서 이웃 두 샘플의 선형 보간이 빗나간 양. 변형 엔진의 단독 스윕 보간과 같은 규칙이다:
    면은 (바디, 면 이름)으로 짝짓고, 점마다 lo + (hi - lo) * t로 섞는다(configurator/src/engine.ts의 addDelta).

    부품마다 형상 오차와 W·D·H 치수 오차를 재서 오차 / 합격선이 가장 큰 것을 돌려준다. 점이 짝지어지지 않으면 None.
    """
    t = (check["value"] - lo["value"]) / (hi["value"] - lo["value"])
    faces_lo = {(f["body"], f["name"]): f["points"] for f in lo["faces"]}
    faces_hi = {(f["body"], f["name"]): f["points"] for f in hi["faces"]}
    predicted: dict[str, list[Point]] = {}
    actual: dict[str, list[Point]] = {}
    distance: dict[str, float] = {}
    for face in check["faces"]:
        key = (face["body"], face["name"])
        a, b = faces_lo.get(key), faces_hi.get(key)
        if a is None or b is None or not len(a) == len(b) == len(face["points"]):
            return None
        part = part_of.get(face["body"], face["body"])
        for pa, pb, pc in zip(a, b, face["points"]):
            p = (pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t)
            predicted.setdefault(part, []).append(p)
            actual.setdefault(part, []).append(tuple(pc))
            distance[part] = max(distance.get(part, 0.0), math.dist(p, pc))
    if not actual:
        return None
    tolerance = _shape_tolerance([p for points in actual.values() for p in points])
    misses = []
    for part in actual:
        misses.append(_Miss("shape_error", part, distance[part], tolerance))
        # 부품별 W·D·H: 바운딩 박스 크기의 차이
        size = max(
            abs(
                (max(p[k] for p in predicted[part]) - min(p[k] for p in predicted[part]))
                - (max(p[k] for p in actual[part]) - min(p[k] for p in actual[part]))
            )
            for k in range(3)
        )
        misses.append(_Miss("dimension_error", part, size, DIMENSION_TOLERANCE))
    return max(misses, key=lambda m: m.ratio)


@dataclass
class _Points:
    """단독 스윕 한 번에 뽑은 점. 재계산 실패로 줄인 쪽은 reductions에, 상한까지 늘려도 합격선을 넘은 구간은 failure에 남는다."""

    samples: list[dict[str, Any]]
    checks: list[dict[str, Any]]
    reductions: dict[str, dict[str, Any]]
    failure: dict[str, Any] | None


def _adaptive_points(
    model: FusionModel, parameter: ParameterInfo, counts: Sequence[str], part_of: dict[str, str]
) -> _Points:
    """적응형 샘플(ADR-0007): 기본값 ±50% 5점 균등에서 시작해 _refine으로 비선형 구간만 나눈다.

    재계산이 실패한 점이 있으면 기본값에서 그쪽으로 가며 처음 실패한 점 안쪽의 가장 먼 점까지로 범위를 줄인다.
    파라미터는 되돌리지 않는다.
    """
    samples = {v: _sample(model, parameter, v, counts) for v in (parameter.value * f for f in SWEEP_FACTORS)}
    checks: dict[float, dict[str, Any]] = {}
    reductions: dict[str, dict[str, Any]] = {}
    failure = _refine(model, parameter, counts, part_of, samples, checks, SAMPLE_LIMIT, reductions)
    return _Points(_by_value(samples), _by_value(checks), reductions, failure)


def _refine(
    model: FusionModel,
    parameter: ParameterInfo,
    counts: Sequence[str],
    part_of: dict[str, str],
    samples: dict[float, dict[str, Any]],
    checks: dict[float, dict[str, Any]],
    limit: int,
    reductions: dict[str, dict[str, Any]] | None,
) -> dict[str, Any] | None:
    """검증점(이웃 샘플 사이 가운데 값, ADR-0012)이 없는 구간에 검증점을 뽑고, 보간 오차가 합격선을 넘는 구간만 그 검증점을
    샘플로 삼아 반으로 나눈다. 샘플이 limit개가 되어도 넘으면 가장 크게 넘은 검증점을 interpolation_failure 형식으로 돌려준다.
    samples·checks는 그 자리에서 바뀐다.

    reductions를 주면 재계산 실패 점부터 바깥을 지우고 그 기록을 담는다(_trim_failures). 주지 않으면 실패한 검증점의 구간은
    보지 않는다. 면 구성이 다른 구간은 보간하지 않으므로 보지 않는다(위상 묶음과 범위 축소의 몫).
    """
    def mixable(a: float, b: float) -> bool:
        return samples[a]["status"] == samples[b]["status"] == "ok" and Composition.of(samples[a]) == Composition.of(samples[b])

    while True:
        values = sorted(samples)
        for a, b in zip(values, values[1:]):
            # 범위를 줄일 때는 모든 구간을 본다(재계산 실패와 위상 변화를 찾는다). 아니면 보간할 구간만 본다.
            if (a + b) / 2 not in checks and (reductions is not None or mixable(a, b)):
                checks[(a + b) / 2] = _sample(model, parameter, (a + b) / 2, counts)
        if reductions is not None:
            trimmed = _trim_failures(parameter.value, samples, checks)
            if trimmed:
                reductions.update(trimmed)
                continue
        values = sorted(samples)
        failing = []
        for a, b in zip(values, values[1:]):
            check = checks.get((a + b) / 2)
            if check is None or not mixable(a, b) or Composition.of(check) != Composition.of(samples[a]):
                continue
            lo, hi = samples[a], samples[b]
            # 면 구성이 같은데 점 수가 다르면 None이다. 그런 묶음은 서버의 업로드 묶음 검사가 거절한다(server/bundle.py).
            miss = _interpolation_error(lo, hi, check, part_of)
            if miss is not None and miss.ratio > 1:
                failing.append((miss, check))
        if not failing:
            return None
        if len(samples) >= limit:
            miss, check = max(failing, key=lambda f: f[0].ratio)
            return miss.failure_json(check["value"])
        # 오차가 큰 구간부터 상한까지 나눈다
        for _, check in sorted(failing, key=lambda f: -f[0].ratio)[: limit - len(samples)]:
            samples[check["value"]] = checks.pop(check["value"])


def _by_value(points: dict[float, dict[str, Any]]) -> list[dict[str, Any]]:
    return [points[v] for v in sorted(points)]


def _trim_failures(
    default: float, samples: dict[float, dict[str, Any]], checks: dict[float, dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    """기본값에서 쪽마다 처음 재계산에 실패한 점부터 바깥을 지운다. 그 안쪽의 가장 먼 점이 검증점이면 샘플로 삼는다.

    줄인 쪽마다 recompute_failed 기록을 돌려준다. 줄일 것이 없으면 빈 사전이다.
    """
    reductions = {}
    for side, outward in (("min", -1), ("max", 1)):
        points = sorted(
            ((v, p) for v, p in [*samples.items(), *checks.items()] if (v - default) * outward > 0),
            key=lambda vp: abs(vp[0] - default),
        )
        failed = next((v for v, p in points if p["status"] != "ok"), None)
        if failed is None:
            continue
        for store in (samples, checks):
            for v in [v for v in store if abs(v - default) >= abs(failed - default) and (v - default) * outward > 0]:
                del store[v]
        inside = [v for v, _ in points if abs(v - default) < abs(failed - default)]
        if inside and inside[-1] in checks:
            samples[inside[-1]] = checks.pop(inside[-1])
        reductions[side] = {
            "side": side,
            "at": failed,
            "reason": "recompute_failed",
            "removed_faces": [],
            "added_faces": [],
            "removed_edges": [],
            "added_edges": [],
            "counts": {},
        }
    return reductions


def _sweep_json(
    parameter: ParameterInfo,
    bounds: dict[str, float],
    samples: list[dict[str, Any]],
    checks: list[dict[str, Any]],
    reductions: dict[str, dict[str, Any]],
    failure: dict[str, Any] | None,
) -> dict[str, Any]:
    """줄어든 범위 밖의 샘플·검증점은 담지 않는다. 줄인 까닭은 reductions에, 범위 안 보간 실패는 interpolation_failure에 남는다."""
    def inside(value: float) -> bool:
        return bounds["min"] <= value <= bounds["max"]

    sweep: dict[str, Any] = {
        "parameter": parameter.name,
        "range": bounds,
        "samples": sorted((s for s in samples if inside(s["value"])), key=lambda s: s["value"]),
        "checks": [c for c in checks if inside(c["value"])],
    }
    if reductions:
        sweep["reductions"] = [reductions[side] for side in ("min", "max") if side in reductions]
    if failure is not None and inside(failure["at"]):
        sweep["interpolation_failure"] = failure
    return sweep


def _part_names(model: FusionModel) -> dict[str, str]:
    """바디 이름 → 부품 이름(ADR-0006). 보간 오차를 부품마다 잴 때 쓴다."""
    return {b.name: b.component if b.component is not None else b.name for b in model.bodies()}


def _single_sweep(model: FusionModel, parameter: ParameterInfo, baseline: Baseline) -> dict[str, Any]:
    """위상 묶음으로 나누지 않는 단독 스윕: 면 구성이 바뀌면 그 앞에서 범위를 줄인다. 다른 파라미터는 지금 값 그대로다."""
    points = _adaptive_points(model, parameter, list(baseline.counts), _part_names(model))
    # 값이 아니라 원래 수식을 되돌린다. 수식으로 묶인 자식 관계를 상수로 덮지 않기 위해서다(ADR-0003).
    model.restore_parameter(parameter)
    bounds, changed = _limit_range(parameter.value, points.samples, points.checks, baseline)
    # 면 구성이 바뀐 지점은 재계산 실패 지점보다 안쪽이다(실패 지점 밖의 점은 이미 지웠다)
    reductions = {**points.reductions, **{r["side"]: r for r in changed}}
    return _sweep_json(parameter, bounds, points.samples, points.checks, reductions, points.failure)


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

    part_of = _part_names(model)
    points = _adaptive_points(model, parameter, list(baseline.counts), part_of)
    samples, checks = points.samples, points.checks
    bounds = {"min": samples[0]["value"], "max": samples[-1]["value"]}
    origin = next(s for s in samples if s["value"] == default)
    sides = {
        name: _split_side(model, parameter, origin, samples + checks, baseline, outward)
        for name, outward in (("min", -1), ("max", 1))
    }
    # 경계 양쪽 점을 샘플로 더한다. 검증점이 경계 끝이면 같은 값의 샘플이 된다(형상이 같다).
    by_value = {s["value"]: s for s in samples}
    edges = [e for side in sides.values() for pair in side.edges for e in pair if e["value"] not in by_value]
    by_value.update((e["value"], e) for e in edges)
    # 경계 샘플과 이웃 샘플 사이 구간도 검증점으로 보간 오차를 재고 나눈다. 경계 샘플은 상한에 넣지 않는다.
    # 재계산 실패로 다시 줄이지는 않는다(위상 묶음을 이미 나눴다). 실패한 검증점의 구간은 보지 않는다.
    by_check = {c["value"]: c for c in checks}
    edge_failure = _refine(
        model, parameter, list(baseline.counts), part_of, by_value, by_check, SAMPLE_LIMIT + len(edges), None
    )
    samples, checks = _by_value(by_value), _by_value(by_check)
    failure = points.failure or edge_failure
    dropped = _limit_groups(default, sides)

    # 위상 때문에 줄인 쪽은 재계산 실패 기록을 덮는다. 면 구성이 바뀐 지점이 더 안쪽이다.
    reductions = dict(points.reductions)
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

    sweep = _sweep_json(parameter, bounds, samples, checks, reductions, failure)
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
    try:
        return server.upload(_bundle(model, parameters, source, extra_sweeps))
    except BaseException:
        # 스윕은 끝날 때마다 수식을 되돌리지만, 도중에 Fusion API가 예외를 내면 바꾼 값이 모델에 남는다.
        # 사용자가 모르고 저장하지 않게, 스윕이 바꾸는 파라미터의 원래 수식을 모두 되돌린다. 하나를 되돌리다
        # 실패해도 나머지는 되돌리고, 알려 줄 예외는 처음 난 것이다.
        for p in parameters:
            if _swept(p, extra_sweeps):
                try:
                    model.restore_parameter(p)
                except Exception:
                    pass
        raise


def _swept(parameter: ParameterInfo, extra_sweeps: Sequence[str]) -> bool:
    """업로드가 단독 스윕으로 바꾸는 파라미터: 사용자 파라미터와 extra_sweeps, 개수형은 뺀다(ADR-0005)."""
    return (parameter.is_user or parameter.name in extra_sweeps) and not is_count(parameter)


def restore_changed_parameters(model: FusionModel, before: list[ParameterInfo]) -> list[str]:
    """업로드 전(before)과 값이나 수식이 달라진 파라미터를 다시 되돌리고, 그 이름을 돌려준다.

    사람이 매개변수 창에서 하나하나 비교하지 않아도 되게, 애드인이 업로드 뒤 스스로 잰다(티켓 26 2절).
    수식까지 보는 것은 값이 같아도 "W / 2"가 상수로 덮이면 자식 관계가 끊기기 때문이다(ADR-0003).
    """
    now = {p.name: p for p in model.parameters()}
    changed = [
        p
        for p in before
        if p.name in now
        and (now[p.name].expression != p.expression or not math.isclose(now[p.name].value, p.value, abs_tol=1e-9))
    ]
    for p in changed:
        model.restore_parameter(p)
    return [p.name for p in changed]


def parameter_expression(value: float, unit: str) -> str:
    """스윕이 파라미터에 쓰는 수식(파이썬 실수 표기, 예: "900.0 mm"). 어댑터가 이 꼴로 값을 넣는다."""
    return f"{value} {unit}"


# parameter_expression이 만든 꼴. 사람은 보통 "900 mm"로 쓰므로, 업로드가 끊겨 되돌리지 못한 값이
# 다음 업로드의 기본값이 된 경우를 녹화본에서 찾는 데 쓴다(scripts.recording_summary). 단위 없는 파라미터는
# 값으로 바꾸므로 흔적이 남지 않는다.
ADDIN_EXPRESSION = re.compile(r"^-?(\d+\.\d+(e[+-]\d+)?|\d+e[+-]\d+|inf|nan) (mm|deg)$")


def _bundle(
    model: FusionModel, parameters: list[ParameterInfo], source: str, extra_sweeps: Sequence[str]
) -> dict[str, Any]:
    baseline = _shape_json(model, baseline=True)
    # 개수형 파라미터(자식 포함)는 스윕하지 않고, 샘플마다 값을 적어 위상이 바뀐 까닭을 가린다.
    reference = Baseline(Composition.of(baseline), {p.name: p.value for p in parameters if is_count(p)})
    swept = [p for p in parameters if _swept(p, extra_sweeps)]
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
    return bundle
