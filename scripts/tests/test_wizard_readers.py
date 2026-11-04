"""위저드가 부르는 읽기 도구(탐색 결과 요점, 애드인 점검 파일)가 위저드가 기대하는 줄을 내는지 본다."""

import os
from pathlib import Path

from scripts.addin_checks import RESTORED_ALL, describe
from scripts.last_error import failure
from scripts.probe_summary import restored, summarize


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
