"""Fusion 애드인 진입점. '구성기 업로드'와 '구성기 업로드 점검' 버튼을 추가한다.

점검은 서버 없이 같은 업로드를 돌려 묶음을 data/dry-runs/에 쓴다. 새 모델의 어댑터 결함을 진짜 업로드 전에 본다.

업로드 뒤에는 서버에 연결된 채로 추가 샘플 요청에 답한다(ADR-0013). Fusion API는 주 스레드에서만 부를 수 있어,
일꾼 스레드가 몇 초마다 사용자 이벤트를 쏘고 주 스레드의 처리기가 요청 하나에 답한다.
"""

import dataclasses
import json
import sys
import threading
import time
import traceback
from typing import NamedTuple
from pathlib import Path

import adsk.core
import adsk.fusion

# 다시 실행할 때 하위 모듈도 새 코드를 읽게, 앞 실행이 남긴 하위 모듈을 지운다. Fusion이 sys.modules를 비우는지
# 확인하지 못해서다(docs/fusion-api.md 「애드인 실행」). 그래야 실행 기록(loaded.txt)이 모든 코드가 새것이라는 뜻이 된다.
for _name in [n for n in sys.modules if __package__ and n.startswith(f"{__package__}.") and n != __name__]:
    del sys.modules[_name]

# Fusion은 애드인을 패키지로 불러온다. 다른 애드인과 모듈 이름이 겹치지 않게 상대 import를 쓴다.
from . import config
from .uploader.core import restore_changed_parameters, run_upload, serve_sample_request
from .uploader.fusion_model import TAG_GROUP, FusionDesignModel, SelfChecks, clear_face_tags
from .uploader.resume import resume_serving
from .uploader.server_client import FileServerClient, HttpServerClient

COMMAND_ID = "configuratorUploaderCommand"
DRY_COMMAND_ID = "configuratorUploaderDryRun"
# 점검 결과와 건식 업로드 묶음을 쓰는 저장소의 data/ (공개 저장소에 올라가지 않음)
_DATA = Path(__file__).resolve().parents[2] / "data"
PANEL_ID = "SolidScriptsAddinsPanel"
SERVE_EVENT_ID = "configuratorUploaderServeSamples"
# 추가 샘플 요청을 찾는 간격(초). 서버의 연결 판정 시간(FUSION_TIMEOUT_S)보다 짧아야 한다.
POLL_S = 3.0
# 이어받기 중 모델을 만들다 실패하면 다시 시도하기까지 쉬는 시간(초)
RESUME_RETRY_S = 60.0

# 이벤트 핸들러는 참조를 잃으면 가비지 컬렉션되어 이벤트가 멈춘다.
_handlers: list[object] = []


class _Serving:
    """업로드한 모델로 추가 샘플 요청에 답하는 상태. 새로 업로드하면 그 묶음으로 바뀐다."""

    def __init__(self) -> None:
        self.model: FusionDesignModel | None = None
        self.upload_id: str | None = None
        self.client = HttpServerClient(config.SERVER_URL)
        self.busy = threading.Event()
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None
        # 업로드 명령이 도는 동안 켜 둔다. 그 사이에는 이어받기도 답하기도 하지 않는다(문서의 면 표시를 만지는 중이다).
        self.paused = threading.Event()
        # 모델을 만들다 이어받기에 실패하면 이 시각(time.monotonic)까지 쉬었다가 다시 시도한다.
        self.resume_retry_at = 0.0

    def active(self) -> bool:
        """앞 업로드가 최종 승인 전 추가 샘플 요청에 답하는 중인지"""
        return self.upload_id is not None

    def forget(self) -> None:
        """앞 업로드에 답하기를 멈추고, 업로드 명령이 끝날 때까지(resume_allowed) 이어받기도 막는다.
        새 어댑터가 면 표시를 다시 붙이면 앞 어댑터의 이름·배치와 어긋난다."""
        self.paused.set()
        self.model, self.upload_id = None, None

    def resume_allowed(self) -> None:
        """업로드 명령이 끝났다. 업로드가 성공했으면 start가 새 업로드로 바꿨고, 아니면 문서에 남은 업로드를 다시 이어받는다
        (건식 업로드는 끝에 면 표시를 지우므로, 이어받으면 표시가 다시 붙는다)."""
        self.paused.clear()

    def start(self, model: FusionDesignModel, upload_id: str) -> None:
        self.model, self.upload_id = model, upload_id
        self.ensure_thread()

    def ensure_thread(self) -> None:
        if self.thread is None:
            self.thread = threading.Thread(target=self._loop, daemon=True)
            self.thread.start()

    def _loop(self) -> None:
        app = adsk.core.Application.get()
        while not self.stop.wait(POLL_S):
            upload_id = self.upload_id
            try:
                # 주 스레드가 샘플을 뽑는 동안에는 연결 신호만 보낸다. 그 밖에는 주 스레드가 한 번 일하게 한다
                # (요청에 답하거나, 답하는 업로드가 없으면 Fusion을 다시 켠 뒤 문서에 적힌 업로드를 이어받는다).
                if upload_id is not None and self.busy.is_set():
                    self.client.heartbeat(upload_id)
                else:
                    app.fireCustomEvent(SERVE_EVENT_ID, "")
            except Exception:
                # 서버가 꺼져 있어도 계속 찾는다. 연결 상태는 서버가 판정한다.
                pass

    def serve_once(self) -> None:
        if self.busy.is_set() or self.paused.is_set():
            return
        self.busy.set()
        try:
            design = adsk.fusion.Design.cast(adsk.core.Application.get().activeProduct)
            if not design:
                return
            # 다른 문서로 옮겼으면 앞 문서의 모델로 답하지 않는다. 그 문서로 돌아오거나 문서에 적힌 업로드가 있는 문서를 열면 이어받는다.
            if self.upload_id is not None and _DocumentUploadId(design).read() != self.upload_id:
                self.model, self.upload_id = None, None
            if self.model is None or self.upload_id is None:
                self._resume(design)
            else:
                serve_sample_request(self.model, self.client, self.upload_id)
        except Exception:
            # 서버가 꺼져 있으면 다음 차례에 다시 찾는다.
            pass
        finally:
            self.busy.clear()

    def _resume(self, design: adsk.fusion.Design) -> None:
        """Fusion을 다시 켠 뒤 열린 문서에 적힌 업로드가 있고 서버가 아직 알면 그 업로드에 이어 답한다(ADR-0013).

        기본 형상에서 면 이름을 다시 짓는다. 업로드 뒤 파라미터를 되돌려 두었으므로 업로드 때와 같은 이름이 나온다.
        면 표시를 다시 붙이므로 문서를 열기만 해도 수정됨으로 바뀐다.
        """
        if time.monotonic() < self.resume_retry_at:
            return
        try:
            resumed = resume_serving(
                _DocumentUploadId(design), self.client, lambda: FusionDesignModel(design), lambda: clear_face_tags(design)
            )
        except Exception:
            # 일시 오류일 수 있어 잠시 쉬었다 다시 시도한다. 3초마다 모델을 다시 만들지는 않는다.
            self.resume_retry_at = time.monotonic() + RESUME_RETRY_S
            _write_error("이어받기 실패", traceback.format_exc())
            return
        if resumed is not None:
            upload_id, model = resumed
            self.start(model, upload_id)


_serving = _Serving()

# 문서에 업로드 ID를 적는 속성. 면 표시(TAG_GROUP/"face")와 같은 그룹이라 문서를 저장하면 함께 남는다.
_NOTE_NAME = "upload_id"


class _DocumentUploadId:
    """열린 디자인에 적어 둔 업로드 ID(uploader.resume.DocumentUploadId)"""

    def __init__(self, design: adsk.fusion.Design) -> None:
        self._design = design

    def read(self) -> str | None:
        attribute = self._design.attributes.itemByName(TAG_GROUP, _NOTE_NAME)
        return str(attribute.value) if attribute else None

    def write(self, upload_id: str) -> None:
        old = self._design.attributes.itemByName(TAG_GROUP, _NOTE_NAME)
        if old:
            old.deleteMe()
        self._design.attributes.add(TAG_GROUP, _NOTE_NAME, upload_id)


class _ServeHandler(adsk.core.CustomEventHandler):
    def notify(self, args: adsk.core.CustomEventArgs) -> None:
        _serving.serve_once()


class _ExecuteHandler(adsk.core.CommandEventHandler):
    """업로드 한 번. 하위 클래스가 묶음을 보낼 곳(_server)과 끝맺음(_finish)을 정한다."""

    label = "업로드"

    def _server(self) -> HttpServerClient | FileServerClient:
        raise NotImplementedError

    def _finish(self, ui: adsk.core.UserInterface, model: FusionDesignModel, upload_id: str, checks: str) -> None:
        raise NotImplementedError

    def notify(self, args: adsk.core.CommandEventArgs) -> None:
        app = adsk.core.Application.get()
        ui = app.userInterface
        model: FusionDesignModel | None = None
        try:
            design = adsk.fusion.Design.cast(app.activeProduct)
            if not design:
                ui.messageBox("디자인 문서를 연 뒤 실행하세요.")
                return
            if _serving.active() and not _confirm(
                ui,
                "앞 업로드가 최종 승인 전 추가 샘플 요청에 답하는 중입니다. 계속하면 면 표시를 다시 붙이므로 "
                "앞 업로드에는 더 답할 수 없습니다. 계속할까요?",
            ):
                return
            _serving.forget()
            model = FusionDesignModel(design)
            before = model.parameters()
            upload_id = run_upload(model, self._server(), ui.messageBox)
            if upload_id:
                checks = _write_checks(upload_id, restore_changed_parameters(model, before), model.checks)
                self._finish(ui, model, upload_id, checks)
        except Exception:
            _report(ui, f"{self.label} 실패", traceback.format_exc())
        finally:
            self._cleanup(model)
            _serving.resume_allowed()

    def _cleanup(self, model: FusionDesignModel | None) -> None:
        pass


class _UploadHandler(_ExecuteHandler):
    def _server(self) -> HttpServerClient:
        return HttpServerClient(config.SERVER_URL)

    def _finish(self, ui: adsk.core.UserInterface, model: FusionDesignModel, upload_id: str, checks: str) -> None:
        design = adsk.fusion.Design.cast(adsk.core.Application.get().activeProduct)
        _DocumentUploadId(design).write(upload_id)
        _serving.start(model, upload_id)
        ui.messageBox(
            f"업로드했습니다: {upload_id}\n{checks}\n최종 승인까지 이 문서를 저장해 두세요. "
            "Fusion을 껐다 켜도 문서를 열면 이어서 답합니다."
        )


class _DryRunHandler(_ExecuteHandler):
    """서버 대신 data/dry-runs/에 묶음을 쓴다. 추가 샘플 요청에는 답하지 않으므로 면 표시도 끝에 지운다."""

    label = "업로드 점검"

    def _server(self) -> FileServerClient:
        return FileServerClient(_DATA / "dry-runs")

    def _finish(self, ui: adsk.core.UserInterface, model: FusionDesignModel, upload_id: str, checks: str) -> None:
        ui.messageBox(f"점검을 마쳤습니다(서버에 올리지 않음): data/dry-runs/{upload_id}.json\n{checks}")

    def _cleanup(self, model: FusionDesignModel | None) -> None:
        if model is not None:
            model.clear_tags()


def _report(ui: adsk.core.UserInterface, title: str, detail: str) -> None:
    """실패를 창에 보이고 data/addin-checks/last-error.txt에도 남긴다. 위저드와 에이전트가 그 파일을 읽어,
    사람이 창의 문장을 옮겨 적지 않아도 되게 한다(티켓 26 2절 회고). 첫 줄은 시각과 제목이다."""
    _write_error(title, detail)
    ui.messageBox(f"{title}:\n{detail}")


def _write_error(title: str, detail: str) -> None:
    """창 없이 data/addin-checks/last-error.txt에만 남긴다. 3초마다 도는 이어받기가 창을 띄우면 안 된다."""
    try:
        path = _DATA / "addin-checks" / "last-error.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {title}\n{detail.rstrip()}\n", encoding="utf-8")
    except OSError:
        pass


def _confirm(ui: adsk.core.UserInterface, text: str) -> bool:
    answer = ui.messageBox(text, "구성기 업로드", adsk.core.MessageBoxButtonTypes.YesNoButtonType)
    return bool(answer == adsk.core.DialogResults.DialogYes)


def _write_checks(upload_id: str, restored: list[str], checks: SelfChecks) -> str:
    """업로드 뒤 애드인이 스스로 잰 점검 결과를 저장소의 data/addin-checks/<업로드 ID>.json에 쓰고 한 줄로 돌려준다.

    녹화 위저드(scripts/fusion-recording-wizard.sh)가 이 파일을 읽는다. 키는 upload_id, restored(업로드 뒤 값이나
    수식이 달라져 다시 되돌린 파라미터)와 SelfChecks의 필드다(docs/recording-guide.md 4-3).
    사람이 Fusion 화면과 값을 비교하지 않아도 되게 하려는 것이다(티켓 26 2절). 애드인을 저장소 밖에 둔 경우처럼
    쓸 수 없으면 창에만 보인다.
    """
    record = {"upload_id": upload_id, "restored": restored, **dataclasses.asdict(checks)}
    try:
        path = _DATA / "addin-checks" / f"{upload_id}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
    except OSError:
        pass
    parameters = f"업로드 뒤 다시 되돌린 파라미터 {', '.join(restored)}" if restored else "파라미터 모두 원래대로"
    proxies = (
        f"어셈블리 좌표 모서리 {checks.proxy_edges}개(옮긴 오커런스 {checks.moved_occurrences}개) 중 "
        f"어긋남 {len(checks.proxy_mismatches)}개"
    )
    return f"점검: {parameters} · {proxies} · 재계산 실패 샘플 {len(checks.recompute_failures)}개"


class _CreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self, execute: type[_ExecuteHandler]) -> None:
        super().__init__()
        self._execute = execute

    def notify(self, args: adsk.core.CommandCreatedEventArgs) -> None:
        handler = self._execute()
        args.command.execute.add(handler)
        _handlers.append(handler)


class _Command(NamedTuple):
    id: str
    name: str
    tooltip: str
    execute: type[_ExecuteHandler]


_COMMANDS = (
    _Command(COMMAND_ID, "구성기 업로드", "모델과 스윕을 구성기 서버로 업로드합니다.", _UploadHandler),
    _Command(
        DRY_COMMAND_ID, "구성기 업로드 점검", "서버 없이 같은 업로드를 돌려 묶음을 data/dry-runs/에 씁니다.", _DryRunHandler
    ),
)


def run(context: object) -> None:
    app = adsk.core.Application.get()
    ui = app.userInterface
    try:
        serve_event = app.registerCustomEvent(SERVE_EVENT_ID)
        serve_handler = _ServeHandler()
        serve_event.add(serve_handler)
        _handlers.append(serve_handler)
        panel = ui.allToolbarPanels.itemById(PANEL_ID)
        for command in _COMMANDS:
            definition = ui.commandDefinitions.itemById(command.id)
            if not definition:
                definition = ui.commandDefinitions.addButtonDefinition(command.id, command.name, command.tooltip)
            handler = _CreatedHandler(command.execute)
            definition.commandCreated.add(handler)
            _handlers.append(handler)
            if not panel.controls.itemById(command.id):
                panel.controls.addCommand(definition)
        _mark_loaded()
        # 문서에 적힌 업로드가 있으면 이어 받으려고, 업로드 전에도 서버를 찾는 일꾼을 켠다.
        _serving.ensure_thread()
    except Exception:
        _report(ui, "애드인 시작 실패", traceback.format_exc())


def _mark_loaded() -> None:
    """애드인을 실행한 시각을 data/addin-checks/loaded.txt에 남긴다. 위저드가 이 파일보다 새로 고친 애드인 코드가
    있으면, 사람이 다시 실행하지 않아 예전 코드로 업로드하려는 것으로 본다(티켓 26 2절, 두 번째 녹화)."""
    try:
        path = _DATA / "addin-checks" / "loaded.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{time.strftime('%Y-%m-%d %H:%M:%S')}\n", encoding="utf-8")
    except OSError:
        pass


def stop(context: object) -> None:
    app = adsk.core.Application.get()
    ui = app.userInterface
    try:
        _serving.stop.set()
        app.unregisterCustomEvent(SERVE_EVENT_ID)
        controls = ui.allToolbarPanels.itemById(PANEL_ID).controls
        for command in _COMMANDS:
            control = controls.itemById(command.id)
            if control:
                control.deleteMe()
            definition = ui.commandDefinitions.itemById(command.id)
            if definition:
                definition.deleteMe()
        _handlers.clear()
    except Exception:
        _report(ui, "애드인 종료 실패", traceback.format_exc())
