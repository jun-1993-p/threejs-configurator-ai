"""애드인이 추가 샘플 요청에 답하는 상태(data/addin-checks/serving.json)에 무엇을 쓰는지 본다(티켓 33)."""

import json
from pathlib import Path
from typing import Any

import pytest
from uploader.serving_status import ObservedServer, ServingStatus, write_record


class FakeClock:
    def __init__(self, now: float) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


# 2026-11-05T10:00:00Z
_T0 = 1793872800.0


def test_상태_기록에는_답하는_업로드와_주_스레드가_마지막으로_일한_시각이_있다() -> None:
    clock = FakeClock(_T0)
    status = ServingStatus(clock)
    clock.now += 2

    status.main_thread_ran()
    status.document_opened("up-1")
    clock.now += 7

    assert status.record(upload="up-1", busy=False, paused=False) == {
        "upload": "up-1",
        "document_upload": "up-1",
        "started_at": "2026-11-05T10:00:00Z",
        "written_at": "2026-11-05T10:00:09Z",
        "main_thread_at": "2026-11-05T10:00:02Z",
        "server_seen_at": None,
        "busy": False,
        "paused": False,
        "error": None,
        "resume_retry_at": None,
    }


def test_이어받기에_실패하면_오류와_다시_시도할_시각을_남긴다() -> None:
    """다시 시도할 때까지 서버를 부르지 않으므로, 서버를 찾지 못하는 것과 가리려면 이 시각이 필요하다."""
    status = ServingStatus(FakeClock(_T0))

    status.resume_failed(RuntimeError("재계산 오류"), retry_in_s=60)

    record = status.record(upload=None, busy=False, paused=False)
    assert (record["error"], record["resume_retry_at"]) == ("이어받기 실패: RuntimeError: 재계산 오류", "2026-11-05T10:01:00Z")


class FakeServer:
    """추가 샘플 요청을 주고받는 서버. reachable이 False면 OSError, known에 없는 업로드의 연결 신호는 False."""

    def __init__(self, known: set[str], reachable: bool = True) -> None:
        self.known = known
        self.reachable = reachable

    def _reach(self) -> None:
        if not self.reachable:
            raise OSError("서버 응답 없음")

    def heartbeat(self, upload_id: str) -> bool:
        self._reach()
        return upload_id in self.known

    def next_sample_request(self, upload_id: str) -> dict[str, Any] | None:
        self._reach()
        return None

    def answer_sample_request(self, upload_id: str, request_id: str, response: dict[str, Any]) -> None:
        self._reach()

    def fail_sample_request(self, upload_id: str, request_id: str, reason: str) -> None:
        self._reach()


def _seen_and_error(status: ServingStatus) -> tuple[Any, Any]:
    record = status.record(upload=None, busy=False, paused=False)
    return record["server_seen_at"], record["error"]


def test_서버가_꺼져_있으면_오류를_남기고_예외는_그대로_던진다() -> None:
    status = ServingStatus(FakeClock(_T0))
    server = ObservedServer(FakeServer({"up-1"}, reachable=False), status)

    with pytest.raises(OSError):
        server.next_sample_request("up-1")

    assert _seen_and_error(status) == (None, "OSError: 서버 응답 없음")


def test_서버가_답하면_찾은_시각을_남기고_앞_오류를_지운다() -> None:
    clock = FakeClock(_T0)
    status = ServingStatus(clock)
    fake = FakeServer({"up-1"}, reachable=False)
    server = ObservedServer(fake, status)
    with pytest.raises(OSError):
        server.heartbeat("up-1")

    fake.reachable = True
    clock.now += 3
    assert server.heartbeat("up-1") is True

    assert _seen_and_error(status) == ("2026-11-05T10:00:03Z", None)


def test_서버가_그_업로드를_모르면_찾은_시각과_함께_모른다는_오류를_남긴다() -> None:
    """서버가 다시 떠 업로드를 잊었거나 다른 서버다. 서버는 찾았으므로 서버가 꺼진 것과 가린다."""
    status = ServingStatus(FakeClock(_T0))

    assert ObservedServer(FakeServer(set()), status).heartbeat("up-gone") is False

    assert _seen_and_error(status) == ("2026-11-05T10:00:00Z", "서버가 업로드 up-gone을(를) 모른다")


def test_상태_파일은_폴더를_만들어_쓰고_다음_기록으로_통째로_바꾼다(tmp_path: Path) -> None:
    path = tmp_path / "addin-checks" / "serving.json"

    status = ServingStatus(FakeClock(_T0))
    write_record(path, status.record(upload="up-1", busy=False, paused=False))
    status.failed("한글 오류")
    write_record(path, status.record(upload=None, busy=False, paused=False))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert (written["upload"], written["error"]) == (None, "한글 오류")
    assert [p.name for p in path.parent.iterdir()] == ["serving.json"]


def test_상태_파일을_쓸_수_없어도_예외를_내지_않는다(tmp_path: Path) -> None:
    """애드인을 저장소 밖에 두었을 때처럼 쓸 수 없으면 일꾼 스레드가 멈추지 않고 넘어간다."""
    blocker = tmp_path / "file"
    blocker.write_text("x", encoding="utf-8")

    write_record(blocker / "serving.json", ServingStatus(FakeClock(_T0)).record(upload=None, busy=False, paused=False))

    assert not (blocker / "serving.json").exists()
