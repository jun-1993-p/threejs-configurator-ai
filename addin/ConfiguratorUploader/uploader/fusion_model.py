"""FusionModel 포트의 실제 Fusion 구현. Fusion 안에서만 동작하며 자동 시험하지 않는다.

Fusion API의 길이는 내부 단위(cm)이므로 묶음에는 mm로 바꿔 담는다.
"""

import adsk.core
import adsk.fusion

from .core import BodyInfo, FaceSample, ParameterInfo, Point

_INTERNAL = "internalUnits"
_CM_TO_MM = 10.0


class FusionDesignModel:
    def __init__(self, design: adsk.fusion.Design) -> None:
        self._design = design
        self._units = design.unitsManager
        # 업로드 전부터 있던 오류는 재계산 실패로 치지 않는다.
        self._initial_errors = self._error_count()

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
        try:
            if unit in ("mm", "deg"):
                parameter.expression = f"{value} {unit}"
            else:
                parameter.value = value
        except Exception:
            return False
        return self._error_count() <= self._initial_errors

    def restore_parameter(self, parameter: ParameterInfo) -> None:
        self._design.allParameters.itemByName(parameter.name).expression = parameter.expression

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

    def sample_faces(self, grid_n: int) -> list[FaceSample]:
        samples = []
        for info, body in self._visible_bodies():
            for i in range(body.faces.count):
                face = body.faces.item(i)
                samples.append(
                    FaceSample(
                        body=info.name,
                        surface=_surface_name(face),
                        points=_grid_points(face, grid_n),
                    )
                )
        return samples


def _surface_name(face: adsk.fusion.BRepFace) -> str:
    names = {
        adsk.core.SurfaceTypes.PlaneSurfaceType: "plane",
        adsk.core.SurfaceTypes.CylinderSurfaceType: "cylinder",
        adsk.core.SurfaceTypes.ConeSurfaceType: "cone",
        adsk.core.SurfaceTypes.SphereSurfaceType: "sphere",
        adsk.core.SurfaceTypes.TorusSurfaceType: "torus",
        adsk.core.SurfaceTypes.EllipticalCylinderSurfaceType: "elliptical_cylinder",
        adsk.core.SurfaceTypes.EllipticalConeSurfaceType: "elliptical_cone",
        adsk.core.SurfaceTypes.NurbsSurfaceType: "nurbs",
    }
    return names.get(face.geometry.surfaceType, "other")


def _grid_points(face: adsk.fusion.BRepFace, grid_n: int) -> list[Point]:
    """면의 매개변수 범위에 n×n 격자를 찍어 점을 얻는다(ADR-0002). 좌표는 mm.

    매개변수 범위는 트림 전 표면의 사각 범위라서, 트림된 면(구멍, 원형 상판)에서는
    일부 점이 면 밖의 표면 위에 찍힌다. 면 안팎 처리는 아직 하지 않는다.
    """
    evaluator = face.evaluator
    box = evaluator.parametricRange()
    u0, v0 = box.minPoint.x, box.minPoint.y
    u1, v1 = box.maxPoint.x, box.maxPoint.y
    params = [
        adsk.core.Point2D.create(
            u0 + (u1 - u0) * i / (grid_n - 1),
            v0 + (v1 - v0) * j / (grid_n - 1),
        )
        for i in range(grid_n)
        for j in range(grid_n)
    ]
    ok, points = evaluator.getPointsAtParameters(params)
    if not ok:
        raise RuntimeError(f"면의 격자 점을 계산하지 못했습니다: {face.body.name}")
    return [(p.x * _CM_TO_MM, p.y * _CM_TO_MM, p.z * _CM_TO_MM) for p in points]
