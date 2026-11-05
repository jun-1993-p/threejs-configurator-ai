"""건식 업로드의 파일 서버가 run_upload의 묶음을 폴더에 쓰고 그 ID를 돌려주는지 본다."""

import json
import threading
import urllib.error
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from fakes import FakeModel
from uploader.core import run_upload
from uploader.server_client import FileServerClient, HttpServerClient


@contextmanager
def _server_knowing(known: str) -> Iterator[str]:
    """연결 신호(POST /uploads/<id>/fusion)에 known 업로드만 204로 답하고 나머지는 404로 답하는 서버. 주소를 돌려준다."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            if self.path == "/uploads/broken/fusion":
                self.send_response(500)
            else:
                self.send_response(204 if self.path == f"/uploads/{known}/fusion" else 404)
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


def test_연결_신호는_서버가_아는_업로드면_참_모르는_업로드면_거짓이다() -> None:
    with _server_knowing("up-1") as url:
        client = HttpServerClient(url)

        assert client.heartbeat("up-1") is True
        assert client.heartbeat("up-gone") is False


def test_연결_신호에_서버가_고장_오류를_내면_모르는_업로드로_치지_않고_예외를_낸다() -> None:
    with _server_knowing("up-1") as url:
        with pytest.raises(urllib.error.HTTPError):
            HttpServerClient(url).heartbeat("broken")


def test_건식_업로드는_묶음을_폴더에_쓰고_그_ID를_돌려준다(tmp_path: Path) -> None:
    upload_id = run_upload(FakeModel(), FileServerClient(tmp_path / "dry-runs"), lambda _: None)

    assert upload_id is not None and upload_id.startswith("dry-")
    bundle = json.loads((tmp_path / "dry-runs" / f"{upload_id}.json").read_text(encoding="utf-8"))
    assert [s["parameter"] for s in bundle["sweeps"]] == ["W", "D"]
