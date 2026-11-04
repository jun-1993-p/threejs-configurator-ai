"""위저드가 부르는 읽기 도구(탐색 결과 요점, 애드인 점검 파일)가 위저드가 기대하는 줄을 내는지 본다."""

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from scripts.addin_checks import RESTORED_ALL, describe
from scripts.last_error import failure
from scripts.probe_summary import restored, summarize

_ROOT = Path(__file__).resolve().parents[2]
_WIZARD_MODULES = sorted(
    {m for sh in (_ROOT / "scripts").glob("*.sh") for m in re.findall(r"-m scripts\.(\w+)", sh.read_text(encoding="utf-8"))}
)


@pytest.mark.parametrize("module", _WIZARD_MODULES)
def test_위저드가_부르는_스크립트는_시험의_pythonpath_없이도_불러진다(module: str) -> None:
    """위저드는 저장소 루트에서 `python -m scripts.<이름>`으로 부른다. pyproject의 pythonpath는 시험에만 있어
    애드인 패키지를 import하던 요점 스크립트가 위저드에서만 실패했다(티켓 26 2절, 두 번째 녹화)."""
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    done = subprocess.run(
        [sys.executable, "-c", f"import scripts.{module}"], cwd=_ROOT, env=env, capture_output=True, text=True, check=False
    )
    assert done.returncode == 0, done.stderr


def test_기준보다_뒤에_쓴_같은_제목의_실패_기록만_읽는다(tmp_path: Path) -> None:
    since, record = tmp_path / "mark", tmp_path / "last-error.txt"
    since.touch()
    os.utime(since, (1000, 1000))
    record.write_text("2026-11-04 13:00:00 업로드 실패\nTraceback\nRuntimeError: 3 : invalid\n", encoding="utf-8")
    os.utime(record, (2000, 2000))

    assert failure(record, since, "업로드 실패") == "2026-11-04 13:00:00 업로드 실패 / RuntimeError: 3 : invalid"
    # 다시 실행하다 난 종료 실패나 점검 실패는 업로드 실패가 아니다
    assert failure(record, since, "업로드 점검 실패") is None
    record.write_text("2026-11-04 13:01:00 애드인 종료 실패\nx\n", encoding="utf-8")
    os.utime(record, (2000, 2000))
    assert failure(record, since, "업로드 실패") is None
    # 기준보다 앞선 기록은 지난 실패다
    os.utime(record, (500, 500))
    assert failure(record, since, "애드인 종료 실패") is None
    # 기준 파일이 없으면 이번 실패인지 알 수 없다. 위저드가 오류로 멈추지 않게 없음으로 본다
    assert failure(record, tmp_path / "missing", "애드인 종료 실패") is None


def test_애드인_점검_파일은_파라미터_좌표_재계산_실패의_세_줄이다() -> None:
    checks = {
        "upload_id": "x",
        "restored": [],
        "proxy_edges": 24,
        "moved_occurrences": 2,
        "proxy_mismatches": ["a/b 모서리: 0.500 mm"],
        "recompute_failures": [],
    }

    assert describe(checks) == [
        RESTORED_ALL,
        "모서리 24개(옮긴 오커런스 2개) 중 어긋남 1개: a/b 모서리: 0.500 mm",
        "0개",
    ]
    assert describe({**checks, "restored": ["W"]})[0] == "업로드 뒤 다시 되돌림: W"


def test_탐색_결과_요점() -> None:
    result = {
        "fusion_version": "1",
        "design_type": "parametric",
        "document": "doc",
        "occurrences": [],
        "base": {"bodies": [{"faces": [{}], "edges": []}], "features": []},
        "variants": [
            {"parameter": "W", "value_mm": 320.0, "compare": {
                "faces_base": 1, "faces_variant": 1, "tags_kept": 1, "same_tempId": 0,
                "same_token": 1, "same_roles": 1, "errors_in_timeline": 0,
            }},
            {"parameter": "H"},
        ],
        "errors_after_restore": 0,
        "probe_errors": [],
    }

    lines = summarize(result)

    assert lines[1].startswith("보이는 바디 1 · 면 1 · 모서리 0")
    assert lines[2].startswith("  W = 320.0 mm: 면 1/1 · 표시 유지 1")
    assert lines[3] == "  H: 바꿔 보지 못함"


def test_탐색이_바꾼_파라미터가_돌아왔는지와_타임라인_오류를_스스로_잰다() -> None:
    result = {
        "base": {"errors_in_timeline": 0},
        "variants": [{"parameter": "W", "expression": "400 mm"}, {"parameter": "D", "expression": "W / 2"}],
        "restored_expressions": {"W": "400 mm", "D": "W / 2"},
        "errors_after_restore": 0,
    }

    assert restored(result) == []
    assert restored({**result, "restored_expressions": {"W": "320.0 mm", "D": "W / 2"}, "errors_after_restore": 1}) == [
        "W: 400 mm → 320.0 mm",
        "타임라인 오류가 0개에서 1개로 늘었다",
    ]
