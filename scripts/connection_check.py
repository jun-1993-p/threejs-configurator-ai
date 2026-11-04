"""업로드 뒤 연결 확인(티켓 26 3절) 위저드가 쓰는 읽기 도구. 사람이 응답을 읽어 판정하지 않게 한다.

    .venv/Scripts/python -m scripts.connection_check request <업로드 묶음>         추가 샘플 요청 본문
    .venv/Scripts/python -m scripts.connection_check created <요청 생성 응답>      요청 ID
    .venv/Scripts/python -m scripts.connection_check state <요청 상태> <요청 본문>  "<상태 낱말> <설명>"

요청은 앞의 두 사용자 파라미터(개수형 제외)를 기본 형상 값 그대로 둔 교차 검증 하나다. 범위 밖 값으로 재계산
실패를 부르지 않고, 애드인이 요청을 가져가 답하는지만 본다. 상태 낱말은 STATES 중 하나이고, 위저드는 문장이
아니라 이 낱말로 판정한다.
"""

import json
import sys
from pathlib import Path
from typing import Any

from server.app import FUSION_TIMEOUT_S

# 답함, 답 대신 실패를 알림, 기다리는 중이고 애드인이 서버를 찾는 중, 기다리는 중이고 Fusion 연결 필요
ANSWERED, FAILED, CONNECTED, DISCONNECTED = "answered", "failed", "connected", "disconnected"
STATES = (ANSWERED, FAILED, CONNECTED, DISCONNECTED)


def request_body(bundle: dict[str, Any]) -> dict[str, Any]:
    chosen = [p for p in bundle["parameters"] if p["is_user"] and not p["is_count"]][:2]
    if not chosen:
        raise ValueError("사용자 파라미터가 없다")
    return {"kind": "cross", "values": [{p["name"]: p["value"] for p in chosen}]}


def describe(state: dict[str, Any], request: dict[str, Any]) -> str:
    """요청 상태(서버의 GET .../sample-requests/<요청>)를 "<상태 낱말> <설명>"으로 줄인다.

    답이 요청한 값 묶음의 샘플이 아니면(순서·값이 다름) 답했어도 실패로 본다.
    """
    if state["status"] == "answered":
        samples = state["response"]["samples"]
        if [s["values"] for s in samples] != request["values"]:
            return f"{FAILED} 요청한 값과 다른 샘플로 답함"
        ok = sum(1 for s in samples if s["status"] == "ok")
        return f"{ANSWERED} 샘플 {len(samples)}개 중 성공 {ok}개"
    if state["status"] == "failed":
        return f"{FAILED} 애드인이 알린 실패: {state['reason']}"
    if state["fusion"] == "connected":
        return f"{CONNECTED} 애드인이 서버를 찾지만 아직 답하지 않음"
    return f"{DISCONNECTED} Fusion 연결 필요(애드인이 {FUSION_TIMEOUT_S:g}초 넘게 서버를 찾지 않음)"


def _read(path: str) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main(args: list[str]) -> None:
    command = args[0]
    if command == "request":
        print(json.dumps(request_body(_read(args[1])), ensure_ascii=False))
    elif command == "created":
        print(_read(args[1])["id"])
    elif command == "state":
        print(describe(_read(args[1]), _read(args[2])))
    else:
        raise SystemExit(f"모르는 명령: {command}")


if __name__ == "__main__":
    main(sys.argv[1:])
