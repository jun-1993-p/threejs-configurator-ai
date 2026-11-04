"""SolidCraft 모델을 애드인 핵심의 FusionModel처럼 다루는 어댑터. 합성 녹화본을 만든다(티켓 24).

solidcraft-cli는 호출마다 새로 설계를 연다. 그래서 바꾼 파라미터를 기억해 두고, 형상이 필요할 때마다
처음부터 다시 적용한 명령 스크립트를 돌린다. 원본 설계 파일은 저장하지 않으므로 바뀌지 않는다.

면의 점은 경계 맞춤 격자다(ADR-0016, 티켓 25). 처음 본 형상(기본 형상)에서 면마다 배치를 만들어 두고,
이후 샘플에서는 이름과 경계 모서리가 같은 면에 그 배치를 그대로 놓는다. 바디는 형상마다 다시 읽는다(티켓 11).
"""

import math

import json
import os
import subprocess
import tempfile
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from uploader.core import BodyInfo, BodyMeasure, EdgeSample, FaceSample, ParameterInfo, Point

from uploader.face_sampling import FaceSampler, FaceSurface, UnsupportedFaceError, spacing_for
from uploader.fitted import Cylinder, Edge, Plane

Runner = Callable[[list[dict[str, Any]]], list[Any]]

DEFAULT_CLI = r"C:\Program Files\SolidCraft\solidcraft-cli.exe"


def cli_runner(design: Path, cli: str | None = None) -> Runner:
    """명령 목록을 `solidcraft-cli run --in design`으로 돌려 명령별 결과를 돌려주는 실행기."""
    exe = cli or os.environ.get("SOLIDCRAFT_CLI", DEFAULT_CLI)

    def run(commands: list[dict[str, Any]]) -> list[Any]:
        with tempfile.TemporaryDirectory() as tmp:
            script, out = Path(tmp) / "script.json", Path(tmp) / "out.json"
            script.write_text(json.dumps({"commands": commands}), encoding="utf-8")
            # --allow-errors: 피처가 실패해도 결과를 받아 재계산 실패로 기록한다
            done = subprocess.run(
                [exe, "run", str(script), "--in", str(design), "--results", "--allow-errors", "--json-out", str(out)],
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
            if done.returncode != 0 or not out.is_file():
                raise RuntimeError(f"solidcraft-cli 실행 실패({done.returncode}): {done.stderr.strip()}")
            result: list[Any] = json.loads(out.read_text(encoding="utf-8"))
            return result

    return run


def _point(p: list[float]) -> Point:
    return (float(p[0]), float(p[1]), float(p[2]))


def _edge(e: dict[str, Any]) -> Edge:
    return Edge(start=_point(e["start"]), mid=_point(e["mid"]), end=_point(e["end"]))


class SolidCraftModel:
    def __init__(self, run: Runner) -> None:
        self._run = run
        self._overrides: dict[str, str] = {}
        self._cache: tuple[tuple[tuple[str, str], ...], dict[str, Any]] | None = None
        listed, measured = run(
            [{"command": "parameters.list", "params": {}}, {"command": "inspect.measure", "params": {}}]
        )
        self._parameters = [
            ParameterInfo(
                name=p["name"],
                value=float(p["value"]),
                unit=p["unit"],
                expression=p["expression"],
                is_user=p["source"] == "user",
            )
            for p in listed["parameters"]
        ]
        self._diagonal = {b["name"]: math.dist(b["bbox"]["min"], b["bbox"]["max"]) for b in measured["bodies"]}
        self._sampler = FaceSampler()

    def parameters(self) -> list[ParameterInfo]:
        return list(self._parameters)

    def bodies(self) -> list[BodyInfo]:
        """지금 형상의 바디. SolidCraft 합성 녹화본은 컴포넌트 없이 바디 단위 부품만 쓴다."""
        return [BodyInfo(name=b, component=None) for b in self._state().get("body_names", [])]

    def set_parameter(self, name: str, value: float) -> bool:
        unit = next(p.unit for p in self._parameters if p.name == name)
        # parameters.list는 각도를 도로 준다. 등판 기울기처럼 비선형 스윕을 만드는 데 쓴다(티켓 05).
        if unit not in ("mm", "deg", ""):
            raise ValueError(f"{name}: 단위 {unit}인 파라미터는 아직 바꿀 수 없습니다(mm·deg만 지원)")
        self._overrides[name] = f"{value} {unit}".strip()
        ok: bool = self._state()["ok"]
        return ok

    def restore_parameter(self, parameter: ParameterInfo) -> None:
        self._overrides.pop(parameter.name, None)

    def parameter_values(self, names: Sequence[str]) -> dict[str, float]:
        """바꾼 파라미터를 적용한 뒤의 값. 개수형 파라미터가 있는 모델에서만 불리므로 형상과 따로 묻는다."""
        commands: list[dict[str, Any]] = [
            {"command": "parameters.change", "params": {"name": n, "expression": e}} for n, e in self._overrides.items()
        ]
        commands.append({"command": "parameters.list", "params": {}})
        listed = {p["name"]: float(p["value"]) for p in self._run(commands)[-1]["parameters"]}
        return {name: listed[name] for name in names}

    def _state(self) -> dict[str, Any]:
        key = tuple(self._overrides.items())
        if self._cache is not None and self._cache[0] == key:
            return self._cache[1]
        changes: list[dict[str, Any]] = [
            {"command": "parameters.change", "params": {"name": n, "expression": e}} for n, e in key
        ]
        try:
            # 바디는 파라미터에 따라 생기거나 사라진다(패턴 개수). 먼저 바디를 알아낸 뒤 면과 모서리를 묻는다.
            *results, inspected, measured = self._run(
                changes
                + [
                    {"command": "document.inspect", "params": {"sketches": False, "measure": False, "joints": False}},
                    {"command": "inspect.measure", "params": {}},
                ]
            )
            bodies = [b["name"] for b in measured["bodies"]]
            topology = [{"command": f"model.{kind}", "params": {"body": b}} for b in bodies for kind in ("faces", "edges")]
            per_body = self._run(changes + topology)[len(key) :]
        except RuntimeError:
            # 명령 자체가 실패한 경우
            state: dict[str, Any] = {"ok": False}
        else:
            ok = not any(c["errors"] for c in results) and not any(f["error"] for f in inspected["timeline"])
            for b in measured["bodies"]:
                # 점 간격은 바디를 처음 본 형상의 대각선으로 정해 모든 샘플에 같게 쓴다
                self._diagonal.setdefault(b["name"], math.dist(b["bbox"]["min"], b["bbox"]["max"]))
            state = {
                "ok": ok,
                "body_names": bodies,
                "faces": {per_body[2 * i]["body"]: per_body[2 * i]["faces"] for i in range(len(bodies))},
                "edges": {per_body[2 * i + 1]["body"]: per_body[2 * i + 1]["edges"] for i in range(len(bodies))},
                "bodies": measured["bodies"],
            }
        self._cache = (key, state)
        return state

    def fix_baseline_layouts(self, grid_n: int) -> None:
        """기본 형상에서 면마다 점 배치를 정해 둔다. 파라미터를 바꾸기 전에 불러야 합성 녹화본과 점 순서가 같다."""
        if self._overrides:
            raise RuntimeError("파라미터를 바꾸기 전에 불러야 합니다")
        self.sample_faces(grid_n)

    def sample_faces(self, grid_n: int) -> list[FaceSample]:
        state = self._state()
        samples = []
        for body in state["body_names"]:
            # 바디를 처음 본 형상(보통 기본 형상)의 크기로 정해 모든 샘플에 같게 쓴다
            spacing = spacing_for(self._diagonal[body], grid_n)
            faces: list[FaceSurface] = []
            for face in state["faces"][body]:
                if face.get("cylinder"):
                    c = face["cylinder"]
                    cylinder = Cylinder(origin=_point(c["origin"]), axis=_point(c["axis"]), radius=float(c["radius"]))
                    faces.append(FaceSurface(face["name"], cylinder))
                elif face.get("plane_normal"):
                    faces.append(FaceSurface(face["name"], Plane(normal=_point(face["plane_normal"]))))
                else:
                    raise UnsupportedFaceError.surface(body, face["name"])
            edges = {e["name"]: _edge(e) for e in state["edges"][body]}
            samples += self._sampler.sample(body, spacing, faces, edges)
        return samples

    def sample_edges(self) -> list[EdgeSample]:
        state = self._state()
        return [
            EdgeSample(body=body, name=e["name"], start=_point(e["start"]), mid=_point(e["mid"]), end=_point(e["end"]))
            for body in state["body_names"]
            for e in state["edges"][body]
        ]

    def measure_bodies(self) -> list[BodyMeasure]:
        return [
            BodyMeasure(
                body=b["name"],
                volume=float(b["volume_mm3"]),
                bbox_min=_point(b["bbox"]["min"]),
                bbox_max=_point(b["bbox"]["max"]),
            )
            for b in self._state()["bodies"]
        ]
