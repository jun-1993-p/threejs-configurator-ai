"""ServerClient 포트의 HTTP 구현. Fusion에 외부 패키지를 설치할 수 없으므로 표준 라이브러리만 쓴다."""

import json
import urllib.error
import urllib.request
from typing import Any, cast

_PING_TIMEOUT_S = 5
_UPLOAD_TIMEOUT_S = 120


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
