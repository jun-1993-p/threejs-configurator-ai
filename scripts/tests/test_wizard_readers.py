"""위저드가 부르는 읽기 도구(탐색 결과 요점, 애드인 점검 파일)가 위저드가 기대하는 줄을 내는지 본다."""

import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from scripts import connection_check
from scripts.addin_checks import RESTORED_ALL, describe, latest_upload
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


def test_마지막_업로드는_애드인이_가장_늦게_쓴_진짜_업로드의_점검_파일이다(tmp_path: Path) -> None:
    """같은 폴더의 애드인 상태 파일(serving.json)은 3초마다 새로 쓰이고, 건식 업로드는 서버에 없다(티켓 33 리뷰)."""
    for name, at in [("up-old.json", 1000), ("up-new.json", 2000), ("dry-20261105.json", 3000), ("serving.json", 4000)]:
        path = tmp_path / name
        path.write_text("{}", encoding="utf-8")
        os.utime(path, (at, at))
    mark = tmp_path / "mark"
    mark.touch()

    os.utime(mark, (1500, 1500))
    assert latest_upload(tmp_path, mark) == "up-new"
    assert latest_upload(tmp_path) == "up-new"
    # 기준 뒤에 쓴 점검 파일이 없으면 이번 업로드는 없다
    os.utime(mark, (2500, 2500))
    assert latest_upload(tmp_path, mark) is None
    assert latest_upload(tmp_path / "missing") is None


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


def test_연결_확인_요청은_앞의_두_사용자_파라미터를_기본_형상_값으로_묻는다() -> None:
    bundle = {"parameters": [
        {"name": "n", "value": 3.0, "is_user": True, "is_count": True},
        {"name": "d1", "value": 5.0, "is_user": False, "is_count": False},
        {"name": "W", "value": 400.0, "is_user": True, "is_count": False},
        {"name": "D", "value": 300.0, "is_user": True, "is_count": False},
        {"name": "H", "value": 700.0, "is_user": True, "is_count": False},
    ]}

    assert connection_check.request_body(bundle) == {"kind": "cross", "values": [{"W": 400.0, "D": 300.0}]}


def test_연결_확인은_요청_상태를_상태_낱말로_시작하는_한_줄로_줄인다() -> None:
    request = {"kind": "cross", "values": [{"W": 400.0}, {"W": 500.0}]}
    samples = [{"values": {"W": 400.0}, "status": "ok"}, {"values": {"W": 500.0}, "status": "failed"}]
    answered = {"status": "answered", "fusion": "connected", "response": {"samples": samples}}

    def word(state: dict[str, Any]) -> str:
        return connection_check.describe(state, request).split(" ", 1)[0]

    assert connection_check.describe(answered, request) == "answered 샘플 2개 중 성공 1개"
    # 기다리는 요청은 Fusion 연결 상태로 가른다. 끊긴 쪽 문장에 "connected"가 들어가도 낱말은 따로다
    assert word({"status": "pending", "fusion": "connected"}) == connection_check.CONNECTED
    assert word({"status": "pending", "fusion": "disconnected"}) == connection_check.DISCONNECTED
    assert word({"status": "failed", "fusion": "connected", "reason": "ValueError: x"}) == connection_check.FAILED
    # 다른 값 묶음의 샘플로 답하면 답한 것으로 보지 않는다
    swapped = {**answered, "response": {"samples": samples[::-1]}}
    assert word(swapped) == connection_check.FAILED
