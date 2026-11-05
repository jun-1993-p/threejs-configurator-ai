"""애드인 상태 파일(data/addin-checks/serving.json)로 "Fusion 연결 필요"의 까닭을 한 줄로 고른다(티켓 33).

    .venv/Scripts/python -m scripts.serving_status data/addin-checks/serving.json [<기다리는 업로드 ID>]

애드인의 일꾼 스레드가 몇 초마다 이 파일을 쓴다(uploader/serving_status.py). 연결 확인 위저드가 끊김을 알릴 때 부른다.
"""

import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

# 기록이 이보다 오래되면 멈춘 것으로 본다. 애드인이 상태를 쓰는 간격(uploader.serving_status.POLL_S, 3초)의 세 배를
# 넘게 둔다. 시험이 두 값을 견준다(위저드는 애드인 패키지를 import하지 않는다).
STALE_S = 10.0
# 샘플 뽑기·이어받기 하나가 이보다 오래가면 주 스레드가 막힌 것으로 본다. 격자 보강 9개도 이 안에 끝난다.
BUSY_STALE_S = 300.0


def _at(record: dict[str, Any], key: str) -> float | None:
    value = record.get(key)
    return None if value is None else datetime.fromisoformat(value).timestamp()


def _age(record: dict[str, Any], key: str, now: float) -> float:
    """그 시각이 now보다 몇 초 앞인지. 아직 없던 일(None)은 애드인을 실행한 시각부터 센다."""
    at = _at(record, key)
    if at is None:
        at = _at(record, "started_at")
    return 0.0 if at is None else now - at


def explain(record: dict[str, Any] | None, now: float, expected: str | None) -> str:
    """기록(없으면 None)을 읽어 애드인이 지금 그 업로드에 답하는지, 아니면 왜 못 하는지 한 줄로 쓴다.
    now는 초(time.time), expected는 기다리는 업로드 ID(모르면 None)다."""
    if record is None:
        return "애드인 상태 파일이 없다: 이 저장소의 애드인을 실행하지 않았거나 상태 파일을 쓰기 전 코드가 돈다"
    written = _age(record, "written_at", now)
    if written > STALE_S:
        return f"애드인이 {written:.0f}초째 상태를 쓰지 않는다: Fusion이 꺼졌거나 애드인이 멈췄다"
    if record["paused"]:
        return "업로드 명령이 도는 중이다: 끝날 때까지 답하지 않는다(창이 열려 있으면 닫는다)"
    upload, document = record["upload"], record["document_upload"]
    main_thread = _age(record, "main_thread_at", now)
    # 샘플을 뽑거나 이어받는 동안 주 스레드는 일하는 중이라 일한 시각(일을 시작한 시각)이 멈춘다. 막힌 것과 가린다.
    if record["busy"] and main_thread > BUSY_STALE_S:
        return (
            f"Fusion 주 스레드가 {main_thread:.0f}초째 같은 일을 하고 있다: "
            "Fusion에 창(메시지 창, 대화 상자)이 열려 있거나 Fusion이 멈췄을 수 있다"
        )
    if record["busy"]:
        if upload is None:
            return f"문서의 업로드 {document}을(를) 이어받는 중이다: 면 이름을 다시 짓고 나면 답한다"
        return f"업로드 {upload}의 샘플을 뽑는 중이다: 끝나면 답한다"
    if main_thread > STALE_S:
        return f"Fusion 주 스레드가 {main_thread:.0f}초째 일하지 않는다: Fusion에 창(메시지 창, 대화 상자)이 열려 있으면 닫는다"
    if upload is None and document is None:
        return "답할 업로드가 없다: 열린 문서에 업로드 ID가 없다(업로드한 문서를 저장했는지, 그 문서가 열려 있는지 본다)"
    retry_at = _at(record, "resume_retry_at")
    # 이어받기에 실패해 쉬는 동안은 서버를 부르지 않으므로 서버를 찾은 시각보다 먼저 본다
    if upload is None and retry_at is not None and retry_at > now:
        return (
            f"답할 업로드가 없다: 문서의 업로드 {document}을(를) 이어받다 실패해 {retry_at - now:.0f}초 뒤 다시 시도한다"
            f"{_error(record)}"
        )
    server = _age(record, "server_seen_at", now)
    if server > STALE_S:
        return (
            f"애드인이 {server:.0f}초째 서버를 찾지 못한다: 서버 주소(config.py의 SERVER_URL)와 서버가 떠 있는지 본다"
            f"{_error(record)}"
        )
    if upload is None and record["error"]:
        return f"답할 업로드가 없다: 문서의 업로드 {document}을(를) 이어받지 못했다{_error(record)}"
    if upload is None:
        return f"문서의 업로드 {document}을(를) 아직 이어받지 않았다"
    if document != upload:
        return f"열린 문서가 업로드 {upload}의 디자인 문서가 아니다: 그 문서를 연다"
    if expected is not None and upload != expected:
        return f"다른 업로드 {upload}에 답하는 중이다: 기다리는 업로드 {expected}의 문서를 연다"
    return f"애드인이 업로드 {upload}에 답하는 중이다"


def _error(record: dict[str, Any]) -> str:
    return f" (마지막 오류: {record['error']})" if record["error"] else ""


def main(args: list[str]) -> None:
    path = Path(args[0])
    record = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    print(explain(record, time.time(), args[1] if len(args) > 1 else None))


if __name__ == "__main__":
    main(sys.argv[1:])
