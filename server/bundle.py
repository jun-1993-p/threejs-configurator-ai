"""업로드 묶음 검사. 형식은 공유 JSON Schema, 면 짝짓기와 점 수는 여기서 확인한다(ADR-0016)."""

import json
import math
from pathlib import Path
from typing import Any

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


def _samples(bundle: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    return [(sweep["parameter"], sample) for sweep in bundle["sweeps"] for sample in sweep["samples"]]


def _samples_and_checks(bundle: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """스윕 샘플과 검증점. 검증점도 기본 형상과 점이 짝지어져야 수치 검증이 잴 수 있다."""
    return _samples(bundle) + [(sweep["parameter"], check) for sweep in bundle["sweeps"] for check in sweep["checks"]]


def sample_topology(bundle: dict[str, Any]) -> list[tuple[str, float, str]]:
    """샘플마다 (파라미터, 값, same | changed | failed). changed는 기본 형상과 면이 짝지어지지 않는 샘플이다."""
    baseline = bundle["baseline"]["faces"]
    out = []
    for parameter, sample in _samples(bundle):
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
    baseline = bundle["baseline"]["faces"]
    for face in baseline:
        n = len(face["points"])
        if any(i >= n for tri in face["triangles"] for i in tri):
            errors.append(f"기본 형상 바디 {face['body']} 면 {face['name']}: 연결(triangles)이 점 {n}개 밖을 가리킵니다")
    for parameter, sample in _samples_and_checks(bundle):
        pairs = pair_faces(baseline, sample["faces"]) if sample["status"] == "ok" else None
        if pairs is None:
            # 재계산 실패나 위상 변화. 위상 변화는 거절하지 않고 sample_topology로 알린다(티켓 10, 11).
            continue
        for i, face in zip(pairs, sample["faces"], strict=True):
            expected = len(baseline[i]["points"])
            if len(face["points"]) != expected:
                errors.append(
                    f"{parameter}={sample['value']} 바디 {face['body']} 면 {face['name']}: "
                    f"점 {len(face['points'])}개가 기본 형상의 {expected}개와 다릅니다"
                )
    return errors
