"""애드인 상태 파일(data/addin-checks/serving.json)로 "Fusion 연결 필요"의 까닭을 고르는지 본다(티켓 33)."""

import time
from pathlib import Path
from typing import Any

from scripts.serving_status import BUSY_STALE_S, STALE_S, explain, main
from uploader.serving_status import POLL_S, ServingStatus

# 2026-11-05T10:00:00Z
_T0 = 1793872800.0


def _record(**changes: Any) -> dict[str, Any]:
    """2026-11-05T10:00:00Z에 쓴, 업로드 up-1에 답하는 기록. 애드인은 1분 전에 실행했다."""
    return {
        "upload": "up-1",
        "document_upload": "up-1",
        "started_at": "2026-11-05T09:59:00Z",
        "written_at": "2026-11-05T10:00:00Z",
        "main_thread_at": "2026-11-05T10:00:00Z",
        "server_seen_at": "2026-11-05T10:00:00Z",
        "busy": False,
        "paused": False,
        "error": None,
        "resume_retry_at": None,
    } | changes


def test_시험의_기록은_애드인이_쓰는_기록과_키가_같다() -> None:
    """위저드는 애드인 패키지를 import하지 않아 키 문자열로만 맞물린다. 한쪽 키가 바뀌면 여기서 드러난다."""
    assert _record().keys() == ServingStatus().record(upload=None, busy=False, paused=False).keys()


def test_멈춘_것으로_보는_시간은_애드인이_상태를_쓰는_간격보다_넉넉하다() -> None:
    assert STALE_S >= 3 * POLL_S


def test_상태_파일이_오래되면_Fusion이_꺼졌거나_애드인이_멈춘_것이다() -> None:
    assert explain(_record(), _T0 + 60, "up-1") == "애드인이 60초째 상태를 쓰지 않는다: Fusion이 꺼졌거나 애드인이 멈췄다"


def test_상태는_새로_쓰는데_주_스레드가_일하지_않으면_주_스레드가_막힌_것이다() -> None:
    record = _record(written_at="2026-11-05T10:00:58Z", main_thread_at="2026-11-05T10:00:00Z")

    assert explain(record, _T0 + 60, "up-1") == (
        "Fusion 주 스레드가 60초째 일하지 않는다: Fusion에 창(메시지 창, 대화 상자)이 열려 있으면 닫는다"
    )


def test_애드인을_막_실행해_아직_없던_일은_실행한_시각부터_센다() -> None:
    """실행 직후 첫 기록은 주 스레드가 일하기 전이고 서버도 찾기 전이다. 그것을 막힌 것으로 읽지 않는다."""
    record = _record(started_at="2026-11-05T10:00:00Z", main_thread_at=None, server_seen_at=None, upload=None)

    assert explain(record, _T0 + 2, "up-1") == "문서의 업로드 up-1을(를) 아직 이어받지 않았다"
    assert explain(record | {"written_at": "2026-11-05T10:00:59Z"}, _T0 + 60, "up-1").startswith(
        "Fusion 주 스레드가 60초째 일하지 않는다"
    )


def test_업로드_명령이_도는_중이면_주_스레드가_막힌_까닭이_그것이다() -> None:
    """업로드 명령도 주 스레드에서 돈다. 그동안 일하지 않는 것은 막힌 것과 다르게 알린다."""
    record = _record(written_at="2026-11-05T10:00:58Z", paused=True)

    assert explain(record, _T0 + 60, "up-1") == (
        "업로드 명령이 도는 중이다: 끝날 때까지 답하지 않는다(창이 열려 있으면 닫는다)"
    )


def test_열린_문서에_업로드_ID가_없으면_답할_업로드를_모른다() -> None:
    record = _record(upload=None, document_upload=None)

    assert explain(record, _T0 + 1, "up-1") == (
        "답할 업로드가 없다: 열린 문서에 업로드 ID가 없다(업로드한 문서를 저장했는지, 그 문서가 열려 있는지 본다)"
    )


def test_서버가_그_업로드를_모르면_이어받지_못한_까닭과_함께_알린다() -> None:
    record = _record(upload=None, error="서버가 업로드 up-1을(를) 모른다")

    assert explain(record, _T0 + 1, "up-1") == (
        "답할 업로드가 없다: 문서의 업로드 up-1을(를) 이어받지 못했다 (마지막 오류: 서버가 업로드 up-1을(를) 모른다)"
    )


def test_이어받기에_실패해_쉬는_동안은_서버를_찾지_못하는_것이_아니다() -> None:
    """쉬는 동안에는 서버를 부르지 않아 서버를 찾은 시각이 멈춘다."""
    record = _record(
        written_at="2026-11-05T10:00:59Z",
        main_thread_at="2026-11-05T10:00:58Z",
        upload=None,
        error="이어받기 실패: RuntimeError: 재계산 오류",
        resume_retry_at="2026-11-05T10:01:30Z",
    )

    assert explain(record, _T0 + 60, "up-1") == (
        "답할 업로드가 없다: 문서의 업로드 up-1을(를) 이어받다 실패해 30초 뒤 다시 시도한다 "
        "(마지막 오류: 이어받기 실패: RuntimeError: 재계산 오류)"
    )


def test_답하는_업로드가_있어도_열린_디자인_문서가_그_문서가_아니면_그것을_알린다() -> None:
    """홈 탭이나 도면처럼 디자인이 아닌 문서가 열려 있으면 답하지 않는다."""
    record = _record(document_upload=None)

    assert explain(record, _T0 + 1, "up-1") == "열린 문서가 업로드 up-1의 디자인 문서가 아니다: 그 문서를 연다"


def test_기다리는_업로드가_아닌_다른_업로드에_답하면_그것을_알린다() -> None:
    record = _record(upload="up-2", document_upload="up-2")

    assert explain(record, _T0 + 1, "up-1") == "다른 업로드 up-2에 답하는 중이다: 기다리는 업로드 up-1의 문서를 연다"


def test_주_스레드가_일하는데_서버에_닿지_않으면_서버를_찾지_못하는_것이다() -> None:
    record = _record(written_at="2026-11-05T10:00:59Z", main_thread_at="2026-11-05T10:00:58Z", error="URLError: refused")
    expected = (
        "애드인이 60초째 서버를 찾지 못한다: 서버 주소(config.py의 SERVER_URL)와 서버가 떠 있는지 본다 "
        "(마지막 오류: URLError: refused)"
    )

    assert explain(record, _T0 + 60, "up-1") == expected
    # 답하는 업로드가 없어도 서버가 꺼진 것은 서버를 찾지 못하는 것이다
    assert explain(record | {"upload": None}, _T0 + 60, "up-1") == expected


def test_샘플을_뽑는_동안에는_주_스레드가_일한_시각이_멈춰도_막힌_것이_아니다() -> None:
    record = _record(written_at="2026-11-05T10:00:59Z", busy=True)

    assert explain(record, _T0 + 60, "up-1") == "업로드 up-1의 샘플을 뽑는 중이다: 끝나면 답한다"


def test_답하는_업로드_없이_주_스레드가_바쁘면_문서의_업로드를_이어받는_중이다() -> None:
    """이어받기는 모델을 다시 만들어 오래 걸린다. 그동안도 막힌 것이 아니다."""
    record = _record(written_at="2026-11-05T10:00:59Z", upload=None, busy=True)

    assert explain(record, _T0 + 60, "up-1") == "문서의 업로드 up-1을(를) 이어받는 중이다: 면 이름을 다시 짓고 나면 답한다"


def test_샘플을_뽑는_일이_너무_오래가면_주_스레드가_막힌_것으로_본다() -> None:
    """샘플을 뽑다 창이 뜨거나 Fusion이 멈추면 바쁜 표시가 풀리지 않는다."""
    late = _T0 + BUSY_STALE_S + 1
    record = _record(written_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(late)), busy=True)

    assert explain(record, late, "up-1") == (
        f"Fusion 주 스레드가 {BUSY_STALE_S + 1:.0f}초째 같은 일을 하고 있다: "
        "Fusion에 창(메시지 창, 대화 상자)이 열려 있거나 Fusion이 멈췄을 수 있다"
    )


def test_모두_새로우면_애드인이_그_업로드에_답하는_중이다() -> None:
    assert explain(_record(), _T0 + 2, "up-1") == "애드인이 업로드 up-1에 답하는 중이다"


def test_상태_파일이_없으면_애드인을_실행하지_않았거나_예전_코드다(tmp_path: Path, capsys: Any) -> None:
    main([str(tmp_path / "serving.json"), "up-1"])

    assert capsys.readouterr().out == (
        "애드인 상태 파일이 없다: 이 저장소의 애드인을 실행하지 않았거나 상태 파일을 쓰기 전 코드가 돈다\n"
    )

