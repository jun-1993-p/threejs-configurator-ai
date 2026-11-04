"""Fusion에서 피처 기준 면 이름과 경계 맞춤 격자용 점 추출을 할 수 있는지 살펴보는 탐색 스크립트(티켓 26 1절).

재계산 뒤 이름이 유지되는지 보려고 사용자 파라미터를 하나씩 0.8배·1.2배로 바꿨다가 원래 수식으로 되돌리고,
면에 붙인 표시(attribute)도 끝에 지운다. 끝나면 디자인은 실행 전과 같다.
애드인 패키지(uploader)를 불러올 수 없는 단독 스크립트라 단위 변환과 피처 역할 목록을 따로 둔다.
결과는 저장소의 data/probes/fusion-probe.json(공개 저장소에 올라가지 않음)에 쓴다.
"""

import json
import traceback
from pathlib import Path

import adsk.core
import adsk.fusion

OUTPUT = Path(__file__).resolve().parents[2] / "data" / "probes" / "fusion-probe.json"
TAG_GROUP = "ConfiguratorProbe"
TAG_NAME = "tag"
# 파라미터 하나당 재계산 2번. 사용자 파라미터가 많으면 앞의 것만 본다.
MAX_PARAMETERS = 6
CM_TO_MM = 10.0

_errors: list[str] = []


def _error(where: str) -> None:
    if len(_errors) < 50:
        _errors.append(f"{where}: {traceback.format_exc(limit=2).strip().splitlines()[-1]}")


def _mm(p: adsk.core.Point3D) -> list[float]:
    return [round(p.x * CM_TO_MM, 6), round(p.y * CM_TO_MM, 6), round(p.z * CM_TO_MM, 6)]


def _vec(v: adsk.core.Vector3D) -> list[float]:
    return [round(v.x, 6), round(v.y, 6), round(v.z, 6)]


def _box(b: adsk.core.BoundingBox3D) -> list[list[float]]:
    return [_mm(b.minPoint), _mm(b.maxPoint)]


def _native_key(face: adsk.fusion.BRepFace) -> str:
    native = face.nativeObject or face
    return f"{native.body.parentComponent.name}/{native.body.name}#{native.tempId}"


def _surface(face: adsk.fusion.BRepFace) -> dict:
    g = face.geometry
    names = {
        adsk.core.SurfaceTypes.PlaneSurfaceType: "plane",
        adsk.core.SurfaceTypes.CylinderSurfaceType: "cylinder",
        adsk.core.SurfaceTypes.ConeSurfaceType: "cone",
        adsk.core.SurfaceTypes.SphereSurfaceType: "sphere",
        adsk.core.SurfaceTypes.TorusSurfaceType: "torus",
        adsk.core.SurfaceTypes.NurbsSurfaceType: "nurbs",
    }
    out: dict = {"type": names.get(g.surfaceType, f"other:{g.surfaceType}")}
    if g.surfaceType == adsk.core.SurfaceTypes.PlaneSurfaceType:
        out.update(origin=_mm(g.origin), normal=_vec(g.normal))
    elif g.surfaceType == adsk.core.SurfaceTypes.CylinderSurfaceType:
        out.update(origin=_mm(g.origin), axis=_vec(g.axis), radius=round(g.radius * CM_TO_MM, 6))
    return out


def _face(face: adsk.fusion.BRepFace) -> dict:
    out: dict = {"tempId": face.tempId, "native": _native_key(face)}
    try:
        out["token"] = face.entityToken
        out["surface"] = _surface(face)
        out["area_mm2"] = round(face.area * CM_TO_MM**2, 6)
        point = face.pointOnFace
        out["point"] = _mm(point)
        ok, normal = face.evaluator.getNormalAtPoint(point)
        out["normal"] = _vec(normal) if ok else None
        out["loops"] = [
            {
                "outer": loop.isOuter,
                "coedges": [[c.edge.tempId, c.isOpposedToEdge] for c in loop.coEdges],
            }
            for loop in face.loops
        ]
        native = face.nativeObject or face
        attr = native.attributes.itemByName(TAG_GROUP, TAG_NAME)
        out["tag"] = attr.value if attr else None
    except Exception:
        _error(f"면 {out['native']}")
    return out


def _edge(edge: adsk.fusion.BRepEdge) -> dict:
    out: dict = {"tempId": edge.tempId}
    try:
        out["faces"] = [f.tempId for f in edge.faces]
        out["curve"] = edge.geometry.curveType
        ev = edge.evaluator
        ok, t0, t1 = ev.getParameterExtents()
        ok_len, length = ev.getLengthAtParameter(t0, t1)
        out["length_mm"] = round(length * CM_TO_MM, 6) if ok_len else None
        # 경계 모서리 위 점을 길이 비율로 놓을 수 있는지 본다. 가운데 점은 길이의 반에서 잡는다.
        ok_mid, t_mid = ev.getParameterAtLength(t0, length / 2)
        points = []
        for t in (t0, t_mid if ok_mid else (t0 + t1) / 2, t1):
            ok_p, p = ev.getPointAtParameter(t)
            points.append(_mm(p) if ok_p else None)
        out["start"], out["mid"], out["end"] = points
    except Exception:
        _error(f"모서리 {edge.tempId}")
    return out


def _bodies(design: adsk.fusion.Design) -> list[tuple[str, str | None, adsk.fusion.BRepBody]]:
    """애드인 어댑터(fusion_model.py)와 같은 방식으로 보이는 바디를 찾는다. 오커런스 안의 것은 프록시."""
    root = design.rootComponent
    found = [(b.name, None, b) for b in root.bRepBodies if b.isVisible]
    for occ in root.allOccurrences:
        if occ.isVisible:
            found += [(f"{occ.fullPathName}/{b.name}", occ.fullPathName, b) for b in occ.bRepBodies if b.isVisible]
    return found


def _feature_roles(design: adsk.fusion.Design) -> list[dict]:
    """타임라인의 피처마다 역할별 면(본래 컴포넌트 기준 키)을 적는다. 피처 기준 면 이름의 재료다."""
    features = []
    timeline = design.timeline
    for i in range(timeline.count):
        item = timeline.item(i)
        entry: dict = {"index": i, "name": item.name}
        try:
            entity = item.entity
            entry["type"] = entity.objectType if entity else None
            entry["health"] = item.healthState
            entry["suppressed"] = item.isSuppressed
            roles = {}
            for role in ("startFaces", "endFaces", "sideFaces", "faces"):
                faces = getattr(entity, role, None)
                if faces is None:
                    continue
                try:
                    roles[role] = [_native_key(f) for f in faces]
                except Exception:
                    _error(f"피처 {item.name}.{role}")
            entry["roles"] = roles
            profile = getattr(entity, "profile", None)
            if profile is not None and hasattr(profile, "profileLoops"):
                entry["profile_curves"] = [loop.profileCurves.count for loop in profile.profileLoops]
        except Exception:
            _error(f"피처 {item.name}")
        features.append(entry)
    return features


def _snapshot(design: adsk.fusion.Design) -> dict:
    bodies = []
    for name, component, body in _bodies(design):
        entry: dict = {"name": name, "component": component}
        try:
            entry["volume_mm3"] = round(body.volume * CM_TO_MM**3, 6)
            entry["bbox"] = _box(body.boundingBox)
            if body.nativeObject:
                entry["native_bbox"] = _box(body.nativeObject.boundingBox)
            entry["faces"] = [_face(f) for f in body.faces]
            entry["edges"] = [_edge(e) for e in body.edges]
        except Exception:
            _error(f"바디 {name}")
        bodies.append(entry)
    return {"bodies": bodies, "features": _feature_roles(design), "errors_in_timeline": _error_count(design)}


def _error_count(design: adsk.fusion.Design) -> int:
    if design.designType != adsk.fusion.DesignTypes.ParametricDesignType:
        return 0
    timeline = design.timeline
    return sum(
        1
        for i in range(timeline.count)
        if timeline.item(i).healthState == adsk.fusion.FeatureHealthStates.ErrorFeatureHealthState
    )


def _api_shapes(design: adsk.fusion.Design) -> dict:
    """어댑터가 기대하는 반환 형식을 첫 바디의 첫 면·모서리로 확인한다."""
    out: dict = {}
    found = _bodies(design)
    if not found:
        return out
    body = found[0][2]
    face = body.faces.item(0)
    try:
        ev = face.evaluator
        box = ev.parametricRange()
        mid = adsk.core.Point2D.create((box.minPoint.x + box.maxPoint.x) / 2, (box.minPoint.y + box.maxPoint.y) / 2)
        result = ev.getPointsAtParameters([box.minPoint, mid])
        out["getPointsAtParameters"] = {
            "type": type(result).__name__,
            "len": len(result) if hasattr(result, "__len__") else None,
            "item_types": [type(r).__name__ for r in result] if isinstance(result, (tuple, list)) else None,
        }
        ok, param = ev.getParameterAtPoint(face.pointOnFace)
        out["getParameterAtPoint_ok"] = ok
        out["isParameterOnFace(pointOnFace)"] = ev.isParameterOnFace(param) if ok else None
        out["isParameterOnFace(range_min)"] = ev.isParameterOnFace(box.minPoint)
    except Exception:
        _error("면 평가기")
    try:
        edge = body.edges.item(0)
        out["getParameterExtents"] = type(edge.evaluator.getParameterExtents()).__name__
        ok, t0, t1 = edge.evaluator.getParameterExtents()
        out["getParameterAtLength"] = [type(x).__name__ for x in edge.evaluator.getParameterAtLength(t0, 0.0)]
    except Exception:
        _error("모서리 평가기")
    return out


def _tag_faces(design: adsk.fusion.Design) -> int:
    count = 0
    for _, _, body in _bodies(design):
        for face in body.faces:
            native = face.nativeObject or face
            if native.attributes.itemByName(TAG_GROUP, TAG_NAME) is None:
                native.attributes.add(TAG_GROUP, TAG_NAME, _native_key(face))
                count += 1
    return count


def _untag(design: adsk.fusion.Design) -> None:
    for attr in design.findAttributes(TAG_GROUP, TAG_NAME):
        try:
            attr.deleteMe()
        except Exception:
            _error("표시 지우기")


def _compare(base: dict, variant: dict) -> dict:
    """기본 형상과 바꾼 형상을 면 표시로 짝지어, 무엇이 재계산 뒤에도 유지되는지 센다."""

    def by_tag(snap: dict) -> dict:
        return {f["tag"]: (b["name"], f) for b in snap["bodies"] for f in b.get("faces", []) if f.get("tag")}

    def roles(snap: dict) -> dict:
        found: dict = {}
        for feature in snap["features"]:
            for role, keys in feature.get("roles", {}).items():
                for key in keys:
                    found.setdefault(key, set()).add(f"{feature['index']}:{role}")
        return found

    a, b = by_tag(base), by_tag(variant)
    shared = a.keys() & b.keys()
    base_roles, variant_roles = roles(base), roles(variant)
    face_total = sum(len(x.get("faces", [])) for x in variant["bodies"])
    return {
        "faces_base": sum(len(x.get("faces", [])) for x in base["bodies"]),
        "faces_variant": face_total,
        "faces_without_tag": face_total - len(b),
        "tags_kept": len(shared),
        "same_tempId": sum(1 for k in shared if a[k][1]["tempId"] == b[k][1]["tempId"]),
        "same_token": sum(1 for k in shared if a[k][1].get("token") == b[k][1].get("token")),
        "same_roles": sum(
            1 for k in shared if base_roles.get(a[k][1]["native"]) == variant_roles.get(b[k][1]["native"])
        ),
        "errors_in_timeline": variant["errors_in_timeline"],
    }


def run(context):
    app = adsk.core.Application.get()
    ui = app.userInterface
    design = adsk.fusion.Design.cast(app.activeProduct)
    if design is None:
        ui.messageBox("디자인 문서를 연 뒤 실행하세요.")
        return
    try:
        units = design.unitsManager
        result: dict = {
            "fusion_version": app.version,
            "document": app.activeDocument.name,
            "design_type": "parametric"
            if design.designType == adsk.fusion.DesignTypes.ParametricDesignType
            else "direct",
            "occurrences": [
                {"path": o.fullPathName, "component": o.component.name, "transform": list(o.transform2.asArray())}
                for o in design.rootComponent.allOccurrences
            ],
            "api_shapes": _api_shapes(design),
            "tagged": _tag_faces(design),
        }
        result["base"] = _snapshot(design)
        result["variants"] = []
        lengths = [
            p
            for p in design.userParameters
            if p.unit and units.convert(1, p.unit, "mm") != -1 and p.value != 0
        ][:MAX_PARAMETERS]
        for parameter in lengths:
            expression = parameter.expression
            value_mm = units.convert(parameter.value, "internalUnits", "mm")
            for factor in (0.8, 1.2):
                variant: dict = {"parameter": parameter.name, "expression": expression, "value_mm": value_mm * factor}
                try:
                    parameter.expression = f"{value_mm * factor} mm"
                    snap = _snapshot(design)
                    variant["compare"] = _compare(result["base"], snap)
                    variant["snapshot"] = snap
                except Exception:
                    _error(f"파라미터 {parameter.name}×{factor}")
                finally:
                    parameter.expression = expression
                result["variants"].append(variant)
        _untag(design)
        result["restored_expressions"] = {p.name: p.expression for p in design.userParameters}
        result["errors_after_restore"] = _error_count(design)
        result["probe_errors"] = _errors
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        lines = [f"탐색을 마쳤습니다: {OUTPUT}", f"면 표시 {result['tagged']}개, 바꿔 본 파라미터 {len(lengths)}개"]
        for v in result["variants"]:
            c = v.get("compare")
            if c:
                lines.append(
                    f"{v['parameter']}={v['value_mm']:.1f}: 면 {c['faces_variant']}/{c['faces_base']}, "
                    f"표시 유지 {c['tags_kept']}, 역할 같음 {c['same_roles']}"
                )
        if _errors:
            lines.append(f"탐색 중 오류 {len(_errors)}건(파일의 probe_errors)")
        ui.messageBox("\n".join(lines))
    except Exception:
        # 중간에 끊겨도 면 표시가 디자인에 남지 않게 한다. 파라미터는 회차마다 되돌린다.
        _untag(design)
        ui.messageBox(f"탐색 실패:\n{traceback.format_exc()}")
