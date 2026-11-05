"""애드인이 추가 샘플 요청에 답하는 상태(data/addin-checks/serving.json)에 쓸 것을 모은다(티켓 33, ADR-0013).

일꾼 스레드가 쓰므로 주 스레드가 막혀도 파일은 새로 쓰이고 주 스레드가 일한 시각만 멈춘다. 읽는 쪽은 scripts/serving_status.py다.
"""

import json
import os
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol, TypedDict, TypeVar

from .core import SampleRequestClient
from .resume import UploadHeartbeat

T = TypeVar("T")

# 일꾼 스레드가 추가 샘플 요청을 찾고 상태를 쓰는 간격(초). 서버의 연결 판정 시간(FUSION_TIMEOUT_S)보다 짧아야 한다.
POLL_S = 3.0


class ServingRecord(TypedDict):
    """serving.json 한 번의 기록. 시각은 UTC ISO 문자열이고, 아직 없던 일은 None이다."""

    upload: str | None  # 지금 답하는 업로드
    document_upload: str | None  # 열린 디자인 문서에 적힌 업로드
    started_at: str | None  # 애드인을 실행한 시각. 아직 없던 일의 경과 시간을 이 시각부터 센다
    written_at: str | None
    main_thread_at: str | None
    server_seen_at: str | None
    busy: bool  # 주 스레드가 추가 샘플 일(샘플 뽑기, 이어받기)을 하는 중
    paused: bool  # 업로드 명령이 도는 중
    error: str | None
    resume_retry_at: str | None  # 이어받기에 실패해 다시 시도할 시각


def _iso(at: float | None) -> str | None:
    return None if at is None else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at))


def describe_error(error: Exception) -> str:
    return f"{type(error).__name__}: {error}"


class ServingStatus:
    """주 스레드와 서버 호출이 알린 일을 모아 기록으로 낸다. 시각은 clock(기본 time.time)의 초다."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._started_at = clock()
        self._main_thread_at: float | None = None
        self._document_upload: str | None = None
        self._server_seen_at: float | None = None
        self._error: str | None = None
        self._resume_retry_at: float | None = None

    def main_thread_ran(self) -> None:
        self._main_thread_at = self._clock()

    def document_opened(self, upload: str | None) -> None:
        """주 스레드가 열린 디자인 문서를 보았다. upload는 그 문서에 적힌 업로드 ID(디자인 문서가 아니면 None)다."""
        self._document_upload = upload

    def server_seen(self) -> None:
        """서버가 답했다. 앞 오류는 지난 일이라 지운다."""
        self._server_seen_at = self._clock()
        self._error = None

    def failed(self, error: Exception | str) -> None:
        self._error = error if isinstance(error, str) else describe_error(error)

    def resume_failed(self, error: Exception, retry_in_s: float) -> None:
        self.failed(f"이어받기 실패: {describe_error(error)}")
        self._resume_retry_at = self._clock() + retry_in_s

    def record(self, upload: str | None, busy: bool, paused: bool) -> ServingRecord:
        return {
            "upload": upload,
            "document_upload": self._document_upload,
            "started_at": _iso(self._started_at),
            "written_at": _iso(self._clock()),
            "main_thread_at": _iso(self._main_thread_at),
            "server_seen_at": _iso(self._server_seen_at),
            "busy": busy,
            "paused": paused,
            "error": self._error,
            "resume_retry_at": _iso(self._resume_retry_at),
        }


def write_record(path: Path, record: ServingRecord) -> None:
    """임시 파일에 쓴 뒤 바꿔 넣어 위저드가 반쯤 쓴 파일을 읽지 않게 한다. 쓸 수 없으면(애드인을 저장소 밖에 둠)
    일꾼 스레드가 멈추지 않게 넘어간다."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, path)
    except OSError:
        pass


class SampleServer(SampleRequestClient, UploadHeartbeat, Protocol):
    """애드인이 업로드 뒤 부르는 서버 호출"""


class ObservedServer:
    """서버 호출마다 서버를 찾았는지와 오류를 ServingStatus에 남기는 SampleServer. 예외는 그대로 던진다."""

    def __init__(self, server: SampleServer, status: ServingStatus) -> None:
        self._server = server
        self._status = status

    def _call(self, call: Callable[[], T]) -> T:
        try:
            result = call()
        except Exception as error:
            self._status.failed(error)
            raise
        self._status.server_seen()
        return result

    def heartbeat(self, upload_id: str) -> bool:
        known = self._call(lambda: self._server.heartbeat(upload_id))
        if not known:
            self._status.failed(f"서버가 업로드 {upload_id}을(를) 모른다")
        return known

    def next_sample_request(self, upload_id: str) -> dict[str, Any] | None:
        return self._call(lambda: self._server.next_sample_request(upload_id))

    def answer_sample_request(self, upload_id: str, request_id: str, response: dict[str, Any]) -> None:
        self._call(lambda: self._server.answer_sample_request(upload_id, request_id, response))

    def fail_sample_request(self, upload_id: str, request_id: str, reason: str) -> None:
        self._call(lambda: self._server.fail_sample_request(upload_id, request_id, reason))
