"""ServerClient 포트의 HTTP 구현과 파일 구현. Fusion에 외부 패키지를 설치할 수 없으므로 표준 라이브러리만 쓴다."""

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, cast

_PING_TIMEOUT_S = 5
_UPLOAD_TIMEOUT_S = 120
_REQUEST_TIMEOUT_S = 30


class FileServerClient:
    """서버 없이 업로드 묶음을 폴더에 쓰는 ServerClient. 건식 업로드(업로드 점검)에 쓴다.

    실제 Fusion 어댑터와 run_upload를 그대로 거치므로, 새 모델의 어댑터 결함이 진짜 업로드 전에 드러난다
    (티켓 26 2절: 탐색 스크립트는 어댑터를 따로 베껴 써서 어댑터 결함 둘을 놓쳤다).
    """

    def __init__(self, folder: Path) -> None:
        self._folder = folder

    def ping(self) -> bool:
        return True

    def upload(self, bundle: dict[str, Any]) -> str:
        # 1초 안에 두 번 눌러도 앞 묶음을 덮지 않게 밀리초까지 쓴다
        upload_id = time.strftime("dry-%Y%m%d-%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}"
        self._folder.mkdir(parents=True, exist_ok=True)
        (self._folder / f"{upload_id}.json").write_text(json.dumps(bundle, ensure_ascii=False), encoding="utf-8")
        return upload_id


class HttpServerClient:
    def __init__(self, base_url: str) -> None:
        self._base_url = base_url.rstrip("/")

    def ping(self) -> bool:
        try:
            with urllib.request.urlopen(f"{self._base_url}/health", timeout=_PING_TIMEOUT_S) as r:
                return bool(r.status == 200)
        except (urllib.error.URLError, OSError):
            return False

    def upload(self, bundle: dict[str, Any]) -> str:
        request = urllib.request.Request(
            f"{self._base_url}/uploads",
            data=json.dumps(bundle, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=_UPLOAD_TIMEOUT_S) as r:
            return cast(str, json.loads(r.read())["id"])

    def _post_json(self, path: str, body: dict[str, Any] | None) -> None:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            f"{self._base_url}{path}", data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(request, timeout=_REQUEST_TIMEOUT_S):
            pass

    def next_sample_request(self, upload_id: str) -> dict[str, Any] | None:
        url = f"{self._base_url}/uploads/{upload_id}/sample-requests/next"
        with urllib.request.urlopen(url, timeout=_REQUEST_TIMEOUT_S) as r:
            return None if r.status == 204 else cast(dict[str, Any], json.loads(r.read()))

    def answer_sample_request(self, upload_id: str, request_id: str, response: dict[str, Any]) -> None:
        self._post_json(f"/uploads/{upload_id}/sample-requests/{request_id}/response", response)

    def fail_sample_request(self, upload_id: str, request_id: str, reason: str) -> None:
        self._post_json(f"/uploads/{upload_id}/sample-requests/{request_id}/failure", {"reason": reason})

    def heartbeat(self, upload_id: str) -> None:
        """샘플을 뽑는 동안 서버에 연결돼 있다고 알린다."""
        self._post_json(f"/uploads/{upload_id}/fusion", None)
