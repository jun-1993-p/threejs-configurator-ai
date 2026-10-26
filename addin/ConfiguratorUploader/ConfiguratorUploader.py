"""Fusion 애드인 진입점. '구성기 업로드' 버튼을 추가하고, 누르면 업로드를 실행한다."""

import traceback

import adsk.core
import adsk.fusion

# Fusion은 애드인을 패키지로 불러온다. 다른 애드인과 모듈 이름이 겹치지 않게 상대 import를 쓴다.
from . import config
from .uploader.core import run_upload
from .uploader.fusion_model import FusionDesignModel
from .uploader.server_client import HttpServerClient

COMMAND_ID = "configuratorUploaderCommand"
PANEL_ID = "SolidScriptsAddinsPanel"

# 이벤트 핸들러는 참조를 잃으면 가비지 컬렉션되어 이벤트가 멈춘다.
_handlers: list[object] = []


class _ExecuteHandler(adsk.core.CommandEventHandler):
    def notify(self, args: adsk.core.CommandEventArgs) -> None:
        app = adsk.core.Application.get()
        ui = app.userInterface
        try:
            design = adsk.fusion.Design.cast(app.activeProduct)
            if not design:
                ui.messageBox("디자인 문서를 연 뒤 실행하세요.")
                return
            upload_id = run_upload(
                FusionDesignModel(design), HttpServerClient(config.SERVER_URL), ui.messageBox
            )
            if upload_id:
                ui.messageBox(f"업로드했습니다: {upload_id}")
        except Exception:
            ui.messageBox(f"업로드 실패:\n{traceback.format_exc()}")


class _CreatedHandler(adsk.core.CommandCreatedEventHandler):
    def notify(self, args: adsk.core.CommandCreatedEventArgs) -> None:
        handler = _ExecuteHandler()
        args.command.execute.add(handler)
        _handlers.append(handler)


def run(context: object) -> None:
    ui = adsk.core.Application.get().userInterface
    try:
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
    ui = adsk.core.Application.get().userInterface
    try:
        control = ui.allToolbarPanels.itemById(PANEL_ID).controls.itemById(COMMAND_ID)
        if control:
            control.deleteMe()
        definition = ui.commandDefinitions.itemById(COMMAND_ID)
        if definition:
            definition.deleteMe()
        _handlers.clear()
    except Exception:
        ui.messageBox(f"애드인 종료 실패:\n{traceback.format_exc()}")
