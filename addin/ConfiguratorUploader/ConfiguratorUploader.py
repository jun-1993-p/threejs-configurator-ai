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
from .uploader.fusion_model import FusionDesignModel, SelfChecks
from .uploader.server_client import FileServerClient, HttpServerClient

COMMAND_ID = "configuratorUploaderCommand"
DRY_COMMAND_ID = "configuratorUploaderDryRun"
# 점검 결과와 건식 업로드 묶음을 쓰는 저장소의 data/ (공개 저장소에 올라가지 않음)
_DATA = Path(__file__).resolve().parents[2] / "data"
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

    def active(self) -> bool:
        """앞 업로드가 최종 승인 전 추가 샘플 요청에 답하는 중인지"""
        return self.upload_id is not None

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

    def _cleanup(self, model: FusionDesignModel | None) -> None:
        pass


class _UploadHandler(_ExecuteHandler):
    def _server(self) -> HttpServerClient:
        return HttpServerClient(config.SERVER_URL)

    def _finish(self, ui: adsk.core.UserInterface, model: FusionDesignModel, upload_id: str, checks: str) -> None:
        _serving.start(model, upload_id)
        ui.messageBox(f"업로드했습니다: {upload_id}\n{checks}\n최종 승인까지 Fusion과 이 문서를 열어 두세요.")


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
    try:
        path = _DATA / "addin-checks" / "last-error.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {title}\n{detail.rstrip()}\n", encoding="utf-8")
    except OSError:
        pass
    ui.messageBox(f"{title}:\n{detail}")


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
