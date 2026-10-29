"""업로드 묶음 검사. 형식은 공유 JSON Schema, 면 짝짓기와 점 수는 여기서 확인한다(ADR-0016)."""

import json
import math
from pathlib import Path
from typing import Any, Literal

import jsonschema

SCHEMA_PATH = Path(__file__).parents[1] / "schema" / "upload-bundle.schema.json"
_schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
_validator = jsonschema.Draft202012Validator(_schema)
_response_validator = jsonschema.Draft202012Validator({"$defs": _schema["$defs"], "$ref": "#/$defs/sampleResponse"})

# 이름이 같은 두 면의 법선(원기둥은 축)이 이보다 덜 나란하면 짝으로 보지 않는다
_PARALLEL = 0.999


def _direction(face: dict[str, Any]) -> list[float] | None:
    geometry = face.get("geometry")
    if geometry is None:
        return None
    v = geometry["normal"] if geometry["type"] == "plane" else geometry["axis"]
    length = math.sqrt(sum(c * c for c in v)) or 1.0
    return [c / length for c in v]


def _same_surface(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """이름으로 짝지은 두 면이 기하로도 같은 면인지 확인한다. 표면 정의가 없으면 종류만 본다."""
    if a["surface"] != b["surface"]:
        return False
    da, db = _direction(a), _direction(b)
    if da is None or db is None:
        return True
    d = sum(x * y for x, y in zip(da, db, strict=True))
    # 평면 법선은 방향까지, 원기둥 축은 방향 없이 비교한다
    return (d if a["surface"] == "plane" else abs(d)) >= _PARALLEL


def pair_faces(baseline: list[dict[str, Any]], sample: list[dict[str, Any]]) -> list[int] | None:
    """샘플의 면마다 짝인 기본 형상 면의 번호. 짝이 하나로 정해지지 않으면 None(위상 변화)."""
    keys = [(f["body"], f["name"]) for f in baseline]
    index = {k: i for i, k in enumerate(keys)}
    sample_keys = [(f["body"], f["name"]) for f in sample]
    if len(index) != len(keys) or len(set(sample_keys)) != len(sample_keys) or set(sample_keys) != set(keys):
        return None
    pairs = [index[k] for k in sample_keys]
    if not all(_same_surface(baseline[i], f) for i, f in zip(pairs, sample, strict=True)):
        return None
    return pairs


Shape = tuple[str, dict[str, Any], list[dict[str, Any]]]


def _baseline_of(bundle: dict[str, Any], sweep: dict[str, Any], value: float) -> list[dict[str, Any]]:
    """샘플 값이 든 위상 묶음의 기준 형상 면. 묶음 밖이면 기본 형상이다(ADR-0005)."""
    for group in sweep.get("groups", []):
        if group["range"]["min"] <= value <= group["range"]["max"]:
            faces: list[dict[str, Any]] = group["baseline"]["faces"]
            return faces
    baseline: list[dict[str, Any]] = bundle["baseline"]["faces"]
    return baseline


def _shapes(bundle: dict[str, Any], key: Literal["samples", "checks"]) -> list[Shape]:
    """(파라미터, 샘플, 짝지을 기준 형상 면). 위상 묶음 안의 단독 스윕은 그 묶음의 기준 형상과 짝짓는다."""
    out: list[Shape] = []
    for sweep in bundle["sweeps"]:
        out += [(sweep["parameter"], s, _baseline_of(bundle, sweep, s["value"])) for s in sweep[key]]
        for group in sweep.get("groups", []):
            faces = group["baseline"]["faces"]
            out += [(inner["parameter"], s, faces) for inner in group["sweeps"] for s in inner[key]]
    return out


def _samples_and_checks(bundle: dict[str, Any]) -> list[Shape]:
    """스윕 샘플과 검증점. 검증점도 기준 형상과 점이 짝지어져야 수치 검증이 잴 수 있다."""
    return _shapes(bundle, "samples") + _shapes(bundle, "checks")


def sample_topology(bundle: dict[str, Any]) -> list[tuple[str, float, str]]:
    """샘플마다 (파라미터, 값, same | changed | failed). changed는 그 값의 기준 형상(기본 형상 또는 위상 묶음)과
    면이 짝지어지지 않는 샘플이다. 위상 묶음 안의 단독 스윕 샘플도 담는다."""
    out = []
    for parameter, sample, baseline in _shapes(bundle, "samples"):
        if sample["status"] != "ok":
            state = "failed"
        else:
            state = "same" if pair_faces(baseline, sample["faces"]) is not None else "changed"
        out.append((parameter, sample["value"], state))
    return out


def _schema_errors(validator: jsonschema.Draft202012Validator, value: Any) -> list[str]:
    return [f"{'/'.join(str(p) for p in e.absolute_path) or '(최상위)'}: {e.message}" for e in validator.iter_errors(value)]


def sample_response_errors(values: list[dict[str, float]], response: Any) -> list[str]:
    """추가 샘플 응답의 문제. 샘플은 요청한 값 묶음과 같은 수, 같은 순서여야 한다."""
    errors = _schema_errors(_response_validator, response)
    if errors:
        return errors
    got = [sample["values"] for sample in response["samples"]]
    if got != values:
        errors.append(f"samples: 요청한 값 묶음 {values}과 응답의 값 묶음 {got}이 다릅니다")
    return errors


def bundle_errors(bundle: dict[str, Any]) -> list[str]:
    """업로드 묶음의 문제를 사람이 읽을 문장으로 돌려준다. 문제가 없으면 빈 목록."""
    errors = _schema_errors(_validator, bundle)
    if errors:
        return errors
    counts = {p["name"] for p in bundle["parameters"] if p["is_count"]}
    for sweep in bundle["sweeps"]:
        if sweep["parameter"] in counts:
            errors.append(f"{sweep['parameter']}: 개수형 파라미터는 스윕하지 않습니다(ADR-0005)")
    baselines = [("기본 형상", bundle["baseline"]["faces"])] + [
        (f"{sweep['parameter']}={group['anchor']} 위상 묶음 기준 형상", group["baseline"]["faces"])
        for sweep in bundle["sweeps"]
        for group in sweep.get("groups", [])
    ]
    for label, faces in baselines:
        for face in faces:
            n = len(face["points"])
            if any(i >= n for tri in face["triangles"] for i in tri):
                errors.append(f"{label} 바디 {face['body']} 면 {face['name']}: 연결(triangles)이 점 {n}개 밖을 가리킵니다")
    for parameter, sample, baseline in _samples_and_checks(bundle):
        pairs = pair_faces(baseline, sample["faces"]) if sample["status"] == "ok" else None
        if pairs is None:
            # 재계산 실패나 위상 변화. 위상 변화는 거절하지 않고 sample_topology로 알린다(티켓 10).
            continue
        for i, face in zip(pairs, sample["faces"], strict=True):
            expected = len(baseline[i]["points"])
            if len(face["points"]) != expected:
                errors.append(
                    f"{parameter}={sample['value']} 바디 {face['body']} 면 {face['name']}: "
                    f"점 {len(face['points'])}개가 기본 형상의 {expected}개와 다릅니다"
                )
    return errors
