"""Fusion을 껐다 켠 뒤 문서에 적힌 업로드에 이어 답할지 가리는 판단(ADR-0013, 티켓 26 3절).

애드인은 답할 업로드 ID를 메모리에만 들고 있어, Fusion을 끄면 잊고 서버를 다시 찾지 않았다. 업로드 때 문서에 ID를
적어 두면(면 표시와 같은 곳이라 문서를 저장하면 따라온다) 다시 켠 뒤 그 문서가 열릴 때 이어 받을 수 있다.
"""

from collections.abc import Callable
from typing import Protocol, TypeVar

Model = TypeVar("Model")


class DocumentUploadId(Protocol):
    """열린 문서에 적어 둔 업로드 ID"""

    def read(self) -> str | None: ...


class UploadHeartbeat(Protocol):
    def heartbeat(self, upload_id: str) -> bool:
        """연결 신호를 보낸다. 서버가 그 업로드를 알면 True, 모르면(서버가 지워졌거나 다른 서버) False. 서버가 꺼져 있으면 예외."""
        ...


def resumable_upload(document: DocumentUploadId, server: UploadHeartbeat) -> str | None:
    """이어 답할 업로드 ID. 문서에 ID가 없거나, 서버가 그 업로드를 모르거나, 서버가 꺼져 있으면 None이다.

    서버가 꺼져 있을 때는 조용히 None을 돌려주어 호출한 쪽이 다음 차례에 다시 묻게 한다. 서버의 다른 HTTP 오류(500)도
    OSError라 같은 길로 간다(서버 고장은 서버 로그에서 본다). 이어받기가 성공하는 순간 연결 신호가 한 번 서버에 닿아
    서버는 Fusion이 다시 붙은 것으로 본다.
    """
    upload_id = document.read()
    if upload_id is None:
        return None
    try:
        return upload_id if server.heartbeat(upload_id) else None
    except OSError:
        return None


def resume_serving(
    document: DocumentUploadId,
    server: UploadHeartbeat,
    build_model: Callable[[], Model],
    discard_tags: Callable[[], None],
) -> tuple[str, Model] | None:
    """이어 답할 업로드가 있으면 (업로드 ID, 새로 만든 모델)을 돌려준다. 이어받을 것이 없으면 None.

    모델을 만들 때 어댑터가 문서에 면 표시를 붙이므로, 만들다 예외가 나면 반쯤 붙은 표시를 치우고(discard_tags)
    예외를 그대로 던진다.
    """
    upload_id = resumable_upload(document, server)
    if upload_id is None:
        return None
    try:
        return upload_id, build_model()
    except Exception:
        discard_tags()
        raise
