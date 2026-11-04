"""FusionModel 포트의 실제 Fusion 구현. Fusion 안에서만 동작하며 자동 시험하지 않는다.

Fusion API의 길이는 내부 단위(cm)이므로 묶음에는 mm로 바꿔 담는다.

면의 점은 경계 맞춤 격자다(ADR-0016). 면 이름은 기본 형상에서 피처와 역할로 지어 면 표시로 붙여 두고,
다른 샘플에서는 표시를 읽는다(face_names). 표시는 다음 업로드 때 지운다. 그때까지 문서에 남지만 형상에는
영향이 없다. 이음선 없는 원기둥(구멍 안쪽, 둥근 다리)은 반쪽 원기둥 둘로 나눠 넘긴다(face_sampling).
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass

import adsk.core
import adsk.fusion

from .core import BodyInfo, EdgeSample, FaceSample, ParameterInfo, Point
from .face_names import EdgeRole, FaceRole, Order, edge_names, face_names
from .face_sampling import (
    FaceSampler,
    FaceSurface,
    UnsupportedFaceError,
    canonical_axis,
    seam,
    spacing_for,
    split_circle,
)
from .fitted import Cylinder, Edge, Plane, Surface

_INTERNAL = "internalUnits"
_CM_TO_MM = 10.0
TAG_GROUP = "ConfiguratorUploader"
TAG_NAME = "face"
# 피처의 역할별 면 모음. 앞의 것이 먼저다(돌출의 faces는 시작·끝·옆면을 모두 담는다).
_ROLES = (("startFaces", "start"), ("endFaces", "end"), ("sideFaces", "side"), ("faces", "face"))
# 이음선 없는 원기둥을 나눈 두 쪽의 이름 꼬리. 첫째가 원을 나눈 축 좌표계의 0°~180° 쪽이다(split_circle).
_HALVES = ("half1", "half2")


@dataclass(frozen=True)
class _Body:
    """한 형상에서 읽은 바디 하나의 면(이름, 표면)과 모서리(이름, 세 점)."""

    info: BodyInfo
    diagonal: float
    faces: list[FaceSurface]
    edges: dict[str, Edge]


class FusionDesignModel:
    def __init__(self, design: adsk.fusion.Design) -> None:
        self._design = design
        self._units = design.unitsManager
        # 업로드 전부터 있던 오류는 재계산 실패로 치지 않는다.
        self._initial_errors = self._error_count()
        self._sampler = FaceSampler()
        self._diagonal: dict[str, float] = {}
        self._shape: list[_Body] | None = None
        self._tag_baseline()

    def _bundle_unit(self, unit: str) -> str:
        """길이는 mm, 각도는 deg로 담는다. 그 밖의 단위는 원래 단위와 내부 값을 그대로 쓴다."""
        # convert는 단위가 호환되지 않으면 -1을 돌려준다.
        if unit and self._units.convert(1, unit, "mm") != -1:
            return "mm"
        if unit and self._units.convert(1, unit, "deg") != -1:
            return "deg"
        return unit

    def parameters(self) -> list[ParameterInfo]:
        result = []
        for i in range(self._design.allParameters.count):
            p = self._design.allParameters.item(i)
            unit = self._bundle_unit(p.unit)
            value = self._units.convert(p.value, _INTERNAL, unit) if unit in ("mm", "deg") else p.value
            is_user = self._design.userParameters.itemByName(p.name) is not None
            result.append(ParameterInfo(p.name, value, unit, p.expression, is_user))
        return result

    def _visible_bodies(self) -> list[tuple[BodyInfo, adsk.fusion.BRepBody]]:
        """보이는 바디를 매번 새로 찾는다. 재계산 뒤에는 이전 프록시가 무효일 수 있다.

        오커런스(컴포넌트 인스턴스) 안의 바디는 그 오커런스에 속한다. 서로 다른 하위 어셈블리의
        같은 이름 오커런스가 섞이지 않도록 전체 경로 이름을 부품 이름으로 쓴다.
        """
        root = self._design.rootComponent
        found = []
        for i in range(root.bRepBodies.count):
            body = root.bRepBodies.item(i)
            if body.isVisible:
                found.append((BodyInfo(name=body.name, component=None), body))
        for i in range(root.allOccurrences.count):
            occurrence = root.allOccurrences.item(i)
            if not occurrence.isVisible:
                continue
            for j in range(occurrence.bRepBodies.count):
                body = occurrence.bRepBodies.item(j)  # 어셈블리 좌표의 프록시
                if body.isVisible:
                    path = occurrence.fullPathName
                    found.append((BodyInfo(name=f"{path}/{body.name}", component=path), body))
        return found

    def bodies(self) -> list[BodyInfo]:
        return [info for info, _ in self._visible_bodies()]

    def set_parameter(self, name: str, value: float) -> bool:
        parameter = self._design.allParameters.itemByName(name)
        unit = self._bundle_unit(parameter.unit)
        self._shape = None
        try:
            if unit in ("mm", "deg"):
                parameter.expression = f"{value} {unit}"
            else:
                parameter.value = value
        except Exception:
            return False
        return self._error_count() <= self._initial_errors

    def restore_parameter(self, parameter: ParameterInfo) -> None:
        self._shape = None
        self._design.allParameters.itemByName(parameter.name).expression = parameter.expression

    def parameter_values(self, names: Sequence[str]) -> dict[str, float]:
        # 개수형 파라미터에 쓴다. 단위가 없어 내부 값이 곧 묶음의 값이다.
        return {name: self._design.allParameters.itemByName(name).value for name in names}

    def _error_count(self) -> int:
        # 직접 모델링 디자인에는 타임라인이 없다.
        if self._design.designType != adsk.fusion.DesignTypes.ParametricDesignType:
            return 0
        timeline = self._design.timeline
        return sum(
            1
            for i in range(timeline.count)
            if timeline.item(i).healthState == adsk.fusion.FeatureHealthStates.ErrorFeatureHealthState
        )

    def _roles(self) -> dict[str, tuple[str, str]]:
        """면(본래 컴포넌트의 entityToken)마다 그 면을 가진 첫 피처와 역할. 직접 모델링 디자인에는 피처가 없다."""
        roles: dict[str, tuple[str, str]] = {}
        if self._design.designType != adsk.fusion.DesignTypes.ParametricDesignType:
            return roles
        timeline = self._design.timeline
        for i in range(timeline.count):
            item = timeline.item(i)
            entity = item.entity
            if entity is None or item.isSuppressed:
                continue
            for attr, role in _ROLES:
                faces = getattr(entity, attr, None)
                if faces is None:
                    continue
                for face in faces:
                    roles.setdefault(face.entityToken, (item.name, role))
        return roles

    def _face_roles(self, body: adsk.fusion.BRepBody, roles: dict[str, tuple[str, str]]) -> list[FaceRole]:
        out = []
        for face in body.faces:
            native = face.nativeObject or face
            feature, role = roles.get(native.entityToken, ("", "face"))
            tag = native.attributes.itemByName(TAG_GROUP, TAG_NAME)
            out.append(FaceRole(feature, role, _order(face), tag.value if tag else None))
        return out

    def _tag_baseline(self) -> None:
        """앞 업로드의 표시를 지우고, 기본 형상의 면에 이름을 붙인다."""
        for attr in self._design.findAttributes(TAG_GROUP, TAG_NAME):
            attr.deleteMe()
        roles = self._roles()
        for _, body in self._visible_bodies():
            names = face_names(self._face_roles(body, roles), baseline=True)
            for face, name in zip(body.faces, names):
                native = face.nativeObject or face
                native.attributes.add(TAG_GROUP, TAG_NAME, name)

    def _read_shape(self) -> list[_Body]:
        """지금 형상의 면과 모서리. 파라미터를 바꾸기 전까지 다시 읽지 않는다."""
        if self._shape is not None:
            return self._shape
        roles = self._roles()
        shape = []
        for info, body in self._visible_bodies():
            faces = list(body.faces)
            names = face_names(self._face_roles(body, roles), baseline=False)
            name_of = {f.tempId: n for f, n in zip(faces, names)}
            seamless = {f.tempId for f, n in zip(faces, names) if _seamless_cylinder(f, info.name, n)}
            surfaces = []
            for f, n in zip(faces, names):
                surface = _surface(f, info.name, n)
                if f.tempId in seamless:
                    surfaces += [FaceSurface(f"{n}:{half}", surface) for half in _HALVES]
                else:
                    surfaces.append(FaceSurface(n, surface))
            shape.append(_Body(info, _diagonal(body), surfaces, _edges(body, faces, name_of, seamless)))
        self._shape = shape
        return shape

    def sample_faces(self, grid_n: int) -> list[FaceSample]:
        samples = []
        for body in self._read_shape():
            # 점 간격은 바디를 처음 본 형상(보통 기본 형상)의 크기로 정해 모든 샘플에 같게 쓴다
            diagonal = self._diagonal.setdefault(body.info.name, body.diagonal)
            samples += self._sampler.sample(body.info.name, spacing_for(diagonal, grid_n), body.faces, body.edges)
        return samples

    def sample_edges(self) -> list[EdgeSample]:
        return [
            EdgeSample(body=body.info.name, name=name, start=e.start, mid=e.mid, end=e.end)
            for body in self._read_shape()
            for name, e in body.edges.items()
        ]


def _mm(p: adsk.core.Point3D) -> Point:
    return (p.x * _CM_TO_MM, p.y * _CM_TO_MM, p.z * _CM_TO_MM)


def _vec(v: adsk.core.Vector3D) -> Point:
    return (v.x, v.y, v.z)


def _rounded(values: Sequence[float]) -> Order:
    return tuple(round(c, 3) for c in values)


def _diagonal(body: adsk.fusion.BRepBody) -> float:
    box = body.boundingBox
    return math.dist(_mm(box.minPoint), _mm(box.maxPoint))


def _normal(face: adsk.fusion.BRepFace) -> Point:
    """면 위 한 점의 바깥쪽 법선. 표면 정의의 법선은 면 방향과 반대일 수 있다."""
    ok, n = face.evaluator.getNormalAtPoint(face.pointOnFace)
    if not ok:
        raise RuntimeError(f"{face.body.name}: 면의 법선을 구하지 못했습니다")
    return _vec(n)


def _order(face: adsk.fusion.BRepFace) -> Order:
    """같은 이름이 여럿일 때 순번을 정하는 열쇠: 표면 방향(평면은 바깥 법선, 원기둥은 축)과 면 중심(mm).

    pointOnFace는 Fusion이 고르는 점이라 샘플마다 달라질 수 있어 쓰지 않는다.
    """
    g = face.geometry
    if g.surfaceType == adsk.core.SurfaceTypes.PlaneSurfaceType:
        direction = _normal(face)
    elif g.surfaceType == adsk.core.SurfaceTypes.CylinderSurfaceType:
        direction = canonical_axis(_vec(g.axis))
    else:
        direction = (0.0, 0.0, 0.0)
    return _rounded((*direction, *_mm(face.centroid)))


def _surface(face: adsk.fusion.BRepFace, body: str, name: str) -> Surface:
    g = face.geometry
    if g.surfaceType == adsk.core.SurfaceTypes.PlaneSurfaceType:
        return Plane(normal=_normal(face))
    if g.surfaceType == adsk.core.SurfaceTypes.CylinderSurfaceType:
        # 축은 부호를 정해 둔다. 재계산 뒤 축이 뒤집혀도 펼친 각도가 거울상이 되지 않는다.
        return Cylinder(origin=_mm(g.origin), axis=canonical_axis(_vec(g.axis)), radius=g.radius * _CM_TO_MM)
    raise UnsupportedFaceError.surface(body, name)


def _is_circle(edge: adsk.fusion.BRepEdge) -> bool:
    return edge.geometry.curveType == adsk.core.Curve3DTypes.Circle3DCurveType


def _seamless_cylinder(face: adsk.fusion.BRepFace, body: str, name: str) -> bool:
    """이음선 없는 원기둥: 직선 모서리가 없는 원기둥 면. 원 두 개로 둘러싸인 것만 반쪽 둘로 나눠 다룬다."""
    if face.geometry.surfaceType != adsk.core.SurfaceTypes.CylinderSurfaceType:
        return False
    if any(e.geometry.curveType == adsk.core.Curve3DTypes.Line3DCurveType for e in face.edges):
        return False
    loops = list(face.loops)
    if len(loops) == 2 and all(loop.edges.count == 1 and _is_circle(loop.edges.item(0)) for loop in loops):
        return True
    raise UnsupportedFaceError(f"{body} 면 {name}: 원 두 개로 둘러싸이지 않은 이음선 없는 원기둥은 아직 다루지 않습니다")


def _closed(edge: adsk.fusion.BRepEdge) -> bool:
    """시작점과 끝점이 같은 모서리(원, 닫힌 곡선)"""
    if edge.startVertex is None or edge.endVertex is None:
        return True
    return edge.startVertex.geometry.isEqualTo(edge.endVertex.geometry)


def _points_at(edge: adsk.fusion.BRepEdge, fractions: Sequence[float]) -> list[Point]:
    """모서리 위 길이 비율 위치의 점(mm)"""
    ev = edge.evaluator
    _, t0, t1 = ev.getParameterExtents()
    _, length = ev.getLengthAtParameter(t0, t1)
    points = []
    for f in fractions:
        ok, t = ev.getParameterAtLength(t0, length * f)
        ok_p, p = ev.getPointAtParameter(t if ok else t0 + (t1 - t0) * f)
        if not ok_p:
            raise RuntimeError(f"{edge.body.name}: 모서리 위 점을 계산하지 못했습니다")
        points.append(_mm(p))
    return points


def _edges(
    body: adsk.fusion.BRepBody,
    faces: list[adsk.fusion.BRepFace],
    name_of: dict[int, str],
    seamless: set[int],
) -> dict[str, Edge]:
    """바디의 모서리. 이름은 두 면 이름 쌍이다(face_names.edge_names).

    - 열린 모서리의 방향은 이름 순으로 앞 면의 고리(코엣지) 방향을 따른다. Fusion의 모서리 방향은 재계산 뒤에도
      같다는 보장이 없어서다.
    - 닫힌 원은 경계 고리를 끝점으로 이을 수 있게 반원 둘로 나눈다(split_circle). 원이 이음선 없는 원기둥에
      닿으면 반원마다 그 원기둥의 같은 쪽 반과 짝짓는다.
    - 이음선 없는 원기둥마다 두 원의 0°와 180° 점을 잇는 이음선 둘(~1, ~2)을 더한다.
    """
    # (면 이름, 모서리 tempId) → 그 면의 고리에서 모서리를 거꾸로 지나는지
    opposed: dict[tuple[str, int], bool] = {}
    for face in faces:
        for loop in face.loops:
            for coedge in loop.coEdges:
                opposed[(name_of[face.tempId], coedge.edge.tempId)] = coedge.isOpposedToEdge
    records: list[tuple[EdgeRole, Edge]] = []
    # 이음선 없는 원기둥(tempId) → [(축 위치, 그 원의 두 반원)]
    circles: dict[int, list[tuple[float, tuple[Edge, Edge]]]] = {}
    for edge in body.edges:
        ids = [f.tempId for f in edge.faces]
        id_a, id_b = (ids + ids)[:2]  # 이음선은 양쪽이 같은 면이다
        if _closed(edge):
            if not _is_circle(edge):
                raise UnsupportedFaceError(f"{body.name}: 원이 아닌 닫힌 모서리는 아직 다루지 않습니다")
            g = edge.geometry
            center, normal = _mm(g.center), _vec(g.normal)
            halves = split_circle(center, normal, g.radius * _CM_TO_MM)
            for half, tail in zip(halves, _HALVES):
                a, b = (name_of[i] + (f":{tail}" if i in seamless else "") for i in (id_a, id_b))
                records.append((EdgeRole(a, b, _rounded(half.mid)), half))
            axis = canonical_axis(normal)
            for i in {id_a, id_b} & seamless:
                circles.setdefault(i, []).append((sum(c * k for c, k in zip(center, axis)), halves))
            continue
        a, b = name_of[id_a], name_of[id_b]
        start, mid, end = _points_at(edge, [0.0, 0.5, 1.0])
        if opposed.get((min(a, b), edge.tempId), False):
            start, end = end, start
        records.append((EdgeRole(a, b, _rounded(mid)), Edge(start=start, mid=mid, end=end)))
    for face_id, rings in circles.items():
        # 이음선 방향은 축 위치가 낮은 원에서 높은 원으로 정해, 모서리 순서와 상관없이 샘플마다 같게 한다
        (_, low), (_, high) = sorted(rings, key=lambda r: r[0])
        name = name_of[face_id]
        for k, (p, q) in enumerate(((low[0].start, high[0].start), (low[0].end, high[0].end))):
            records.append((EdgeRole(f"{name}:{_HALVES[0]}", f"{name}:{_HALVES[1]}", (float(k),)), seam(p, q)))
    names = edge_names([role for role, _ in records])
    return {name: edge for name, (_, edge) in zip(names, records)}
