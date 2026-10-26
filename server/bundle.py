"""업로드 묶음 검사. 형식은 공유 JSON Schema, 격자 점 수는 여기서 확인한다."""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import jsonschema

SCHEMA_PATH = Path(__file__).parents[1] / "schema" / "upload-bundle.schema.json"
_validator = jsonschema.Draft202012Validator(json.loads(SCHEMA_PATH.read_text(encoding="utf-8")))


def _all_faces(bundle: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
    yield from (("baseline", f) for f in bundle["baseline"]["faces"])
    for sweep in bundle["sweeps"]:
        for sample in sweep["samples"]:
            where = f"{sweep['parameter']}={sample['value']}"
            yield from ((where, f) for f in sample["faces"])


def bundle_errors(bundle: dict[str, Any]) -> list[str]:
    """업로드 묶음의 문제를 사람이 읽을 문장으로 돌려준다. 문제가 없으면 빈 목록."""
    errors = [
        f"{'/'.join(str(p) for p in e.absolute_path) or '(최상위)'}: {e.message}"
        for e in _validator.iter_errors(bundle)
    ]
    if errors:
        return errors
    expected = bundle["grid"]["n"] ** 2
    return [
        f"{where} 바디 {face['body']}: 면의 점 {len(face['points'])}개가 격자 {expected}개와 다릅니다"
        for where, face in _all_faces(bundle)
        if len(face["points"]) != expected
    ]
