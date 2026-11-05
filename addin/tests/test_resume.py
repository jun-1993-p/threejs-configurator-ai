"""Fusion을 껐다 켠 뒤 문서에 적힌 업로드에 이어 답할지 가리는 판단을 본다(ADR-0013, 티켓 26 3절)."""

import pytest
from uploader.resume import resume_serving, resumable_upload


class FakeDocumentUploadId:
    """문서에 적어 둔 업로드 ID"""

    def __init__(self, upload_id: str | None) -> None:
        self.upload_id = upload_id

    def read(self) -> str | None:
        return self.upload_id


class FakeHeartbeat:
    """서버의 연결 신호 받는 곳. known에 든 업로드만 안다."""

    def __init__(self, known: set[str] | None = None, reachable: bool = True) -> None:
        self.known = known or set()
        self.reachable = reachable
        self.calls: list[str] = []

    def heartbeat(self, upload_id: str) -> bool:
        self.calls.append(upload_id)
        if not self.reachable:
            raise OSError("서버 응답 없음")
        return upload_id in self.known


def test_문서에_적힌_업로드를_서버가_알면_그_ID로_이어_답한다() -> None:
    server = FakeHeartbeat({"up-1"})

    assert resumable_upload(FakeDocumentUploadId("up-1"), server) == "up-1"


def test_문서에_업로드_ID가_없으면_서버를_부르지_않고_이어받지_않는다() -> None:
    server = FakeHeartbeat({"up-1"})

    assert resumable_upload(FakeDocumentUploadId(None), server) is None
    assert server.calls == []


def test_서버가_그_업로드를_모르면_이어받지_않는다() -> None:
    assert resumable_upload(FakeDocumentUploadId("up-gone"), FakeHeartbeat({"up-1"})) is None


def test_서버가_꺼져_있으면_이어받지_않고_예외도_내지_않는다() -> None:
    assert resumable_upload(FakeDocumentUploadId("up-1"), FakeHeartbeat({"up-1"}, reachable=False)) is None


def test_이어받으면_업로드_ID와_새로_만든_모델을_돌려준다() -> None:
    discarded: list[str] = []

    result = resume_serving(FakeDocumentUploadId("up-1"), FakeHeartbeat({"up-1"}), lambda: "model", lambda: discarded.append("x"))

    assert result == ("up-1", "model")
    assert discarded == []


def test_이어받지_않으면_모델을_만들지_않는다() -> None:
    built: list[str] = []

    def build() -> str:
        built.append("x")
        return "model"

    result = resume_serving(FakeDocumentUploadId(None), FakeHeartbeat(), build, lambda: None)

    assert result is None
    assert built == []


def test_모델을_만들다_예외가_나면_도중에_붙은_면_표시를_치우고_예외를_다시_던진다() -> None:
    """어댑터는 만들 때 문서에 면 표시를 붙인다. 도중에 Fusion API가 실패하면 반쯤 붙은 표시가 문서에 남으면 안 된다."""
    discarded: list[str] = []

    def fails() -> str:
        raise RuntimeError("재계산 오류")

    with pytest.raises(RuntimeError):
        resume_serving(FakeDocumentUploadId("up-1"), FakeHeartbeat({"up-1"}), fails, lambda: discarded.append("cleared"))

    assert discarded == ["cleared"]
