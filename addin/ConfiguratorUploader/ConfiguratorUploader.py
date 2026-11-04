"""Fusion 애드인 진입점. '구성기 업로드' 버튼을 추가하고, 누르면 업로드를 실행한다.

업로드 뒤에는 서버에 연결된 채로 추가 샘플 요청에 답한다(ADR-0013). Fusion API는 주 스레드에서만 부를 수 있어,
일꾼 스레드가 몇 초마다 사용자 이벤트를 쏘고 주 스레드의 처리기가 요청 하나에 답한다.
"""

import threading
import traceback

import adsk.core
import adsk.fusion

# Fusion은 애드인을 패키지로 불러온다. 다른 애드인과 모듈 이름이 겹치지 않게 상대 import를 쓴다.
from . import config
from .uploader.core import run_upload, serve_sample_request
from .uploader.fusion_model import FusionDesignModel
from .uploader.server_client import HttpServerClient

COMMAND_ID = "configuratorUploaderCommand"
PANEL_ID = "SolidScriptsAddinsPanel"
SERVE_EVENT_ID = "configuratorUploaderServeSamples"
# 추가 샘플 요청을 찾는 간격(초). 서버의 연결 판정 시간(FUSION_TIMEOUT_S)보다 짧아야 한다.
POLL_S = 3.0

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

    def forget(self) -> None:
        """앞 업로드에 답하기를 멈춘다. 새 어댑터가 면 표시를 다시 붙이면 앞 어댑터의 이름·배치와 어긋난다."""
        self.model, self.upload_id = None, None

    def start(self, model: FusionDesignModel, upload_id: str) -> None:
        self.model, self.upload_id = model, upload_id
        if self.thread is None:
            self.thread = threading.Thread(target=self._loop, daemon=True)
            self.thread.start()

    def _loop(self) -> None:
        app = adsk.core.Application.get()
        while not self.stop.wait(POLL_S):
            upload_id = self.upload_id
            if upload_id is None:
                continue
            try:
                # 주 스레드가 샘플을 뽑는 동안에는 연결 신호만 보낸다.
                if self.busy.is_set():
                    self.client.heartbeat(upload_id)
                else:
                    app.fireCustomEvent(SERVE_EVENT_ID, upload_id)
            except Exception:
                # 서버가 꺼져 있어도 계속 찾는다. 연결 상태는 서버가 판정한다.
                pass

    def serve_once(self) -> None:
        if self.model is None or self.upload_id is None or self.busy.is_set():
            return
        self.busy.set()
        try:
            serve_sample_request(self.model, self.client, self.upload_id)
        except Exception:
            # 서버가 꺼져 있으면 다음 차례에 다시 찾는다.
            pass
        finally:
            self.busy.clear()


_serving = _Serving()


class _ServeHandler(adsk.core.CustomEventHandler):
    def notify(self, args: adsk.core.CustomEventArgs) -> None:
        _serving.serve_once()


class _ExecuteHandler(adsk.core.CommandEventHandler):
    def notify(self, args: adsk.core.CommandEventArgs) -> None:
        app = adsk.core.Application.get()
        ui = app.userInterface
        try:
            design = adsk.fusion.Design.cast(app.activeProduct)
            if not design:
                ui.messageBox("디자인 문서를 연 뒤 실행하세요.")
                return
            _serving.forget()
            model = FusionDesignModel(design)
            upload_id = run_upload(model, HttpServerClient(config.SERVER_URL), ui.messageBox)
            if upload_id:
                _serving.start(model, upload_id)
                ui.messageBox(f"업로드했습니다: {upload_id}\n최종 승인까지 Fusion과 이 문서를 열어 두세요.")
        except Exception:
            ui.messageBox(f"업로드 실패:\n{traceback.format_exc()}")


class _CreatedHandler(adsk.core.CommandCreatedEventHandler):
    def notify(self, args: adsk.core.CommandCreatedEventArgs) -> None:
        handler = _ExecuteHandler()
        args.command.execute.add(handler)
        _handlers.append(handler)


def run(context: object) -> None:
    app = adsk.core.Application.get()
    ui = app.userInterface
    try:
        serve_event = app.registerCustomEvent(SERVE_EVENT_ID)
        serve_handler = _ServeHandler()
        serve_event.add(serve_handler)
        _handlers.append(serve_handler)
        definition = ui.commandDefinitions.itemById(COMMAND_ID)
        if not definition:
            definition = ui.commandDefinitions.addButtonDefinition(
                COMMAND_ID, "구성기 업로드", "모델과 스윕을 구성기 서버로 업로드합니다."
            )
        handler = _CreatedHandler()
        definition.commandCreated.add(handler)
        _handlers.append(handler)
        panel = ui.allToolbarPanels.itemById(PANEL_ID)
        if not panel.controls.itemById(COMMAND_ID):
            panel.controls.addCommand(definition)
    except Exception:
        ui.messageBox(f"애드인 시작 실패:\n{traceback.format_exc()}")


def stop(context: object) -> None:
    app = adsk.core.Application.get()
    ui = app.userInterface
    try:
        _serving.stop.set()
        app.unregisterCustomEvent(SERVE_EVENT_ID)
        control = ui.allToolbarPanels.itemById(PANEL_ID).controls.itemById(COMMAND_ID)
        if control:
            control.deleteMe()
        definition = ui.commandDefinitions.itemById(COMMAND_ID)
        if definition:
            definition.deleteMe()
        _handlers.clear()
    except Exception:
        ui.messageBox(f"애드인 종료 실패:\n{traceback.format_exc()}")
