"""어댑터가 함께 쓰는 면 표본(ADR-0016). SolidCraft·Fusion 어댑터가 바디마다 면(이름, 표면)과 모서리(이름, 세 점)를
넘기면, 경계 맞춤 격자(fitted)로 점을 놓아 FaceSample을 만든다.

Fusion의 이음선 없는 원기둥(구멍 안쪽, 둥근 다리)은 경계 맞춤 격자가 펼칠 자리가 없어, 어댑터가 반쪽 원기둥
둘로 나눠 넘긴다. 나누는 자리를 축 좌표계로 정하는 도움 함수(split_circle, seam)도 여기 둔다.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from .core import FaceSample
from .face_names import edge_faces
from .fitted import Cylinder, Edge, FaceLayout, Surface, Vec, build_layout, frame, place


class UnsupportedFaceError(Exception):
    """경계 맞춤 격자로 다루지 못하는 면. 평면과 원기둥만 다룬다."""

    @classmethod
    def surface(cls, body: str, face: str) -> "UnsupportedFaceError":
        return cls(f"{body} 면 {face}: 평면과 원기둥만 다룹니다")


@dataclass(frozen=True)
class FaceSurface:
    name: str
    surface: Surface


def spacing_for(diagonal: float, grid_n: int) -> float:
    """점 간격: 바디 바운딩 박스 대각선 / (2(n-1)). 어댑터는 바디를 처음 본 형상의 대각선을 넘긴다."""
    return diagonal / (2 * (grid_n - 1))


def _geometry(surface: Surface) -> dict[str, Any]:
    if isinstance(surface, Cylinder):
        return {"type": "cylinder", "origin": list(surface.origin), "axis": list(surface.axis), "radius": surface.radius}
    return {"type": "plane", "normal": list(surface.normal)}


@dataclass
class FaceSampler:
    """바디 하나의 면들을 경계 맞춤 격자로 표본한다.

    배치는 (바디, 면 이름, 경계 모서리)마다 처음 본 형상에서 만든다. 기본 형상에 없던 면이나
    경계 모서리가 달라진 면(위상 변화)도 같은 위상 묶음의 샘플끼리는 같은 배치로 놓인다(ADR-0005).
    """

    _layouts: dict[tuple[str, str, frozenset[str]], FaceLayout] = field(default_factory=dict)

    def sample(self, body: str, spacing: float, faces: Sequence[FaceSurface], edges: dict[str, Edge]) -> list[FaceSample]:
        names = {f.name for f in faces}
        pairs = [(edge_faces(n, names), n, e) for n, e in edges.items()]
        samples = []
        for face in faces:
            bound = {n: e for pair, n, e in pairs if face.name in pair}
            key = (body, face.name, frozenset(bound))
            if key not in self._layouts:
                self._layouts[key] = build_layout(face.surface, bound, spacing)
            layout = self._layouts[key]
            samples.append(
                FaceSample(
                    body=body,
                    surface="cylinder" if isinstance(face.surface, Cylinder) else "plane",
                    points=place(layout, face.surface, bound),
                    name=face.name,
                    geometry=_geometry(face.surface),
                    triangles=layout.triangles,
                )
            )
        return samples


def canonical_axis(v: Vec) -> Vec:
    """부호를 정한 단위 축: 크기가 가장 큰 성분이 양수. CAD가 재계산 뒤 축 방향을 뒤집어도 같은 축이 된다."""
    length = math.sqrt(sum(c * c for c in v))
    u = (v[0] / length, v[1] / length, v[2] / length)
    big = max(range(3), key=lambda i: abs(u[i]))
    return u if u[big] > 0 else (-u[0], -u[1], -u[2])


def split_circle(center: Vec, normal: Vec, radius: float) -> tuple[Edge, Edge]:
    """닫힌 원을 반원 둘로 나눈다. 첫째는 축 좌표계(frame)의 0°에서 90°를 지나 180°까지, 둘째는 나머지다.

    나누는 자리가 축(부호를 정한 법선)으로만 정해지므로, 같은 축의 원끼리(원기둥의 위·아래 원) 같은 각도에서
    나뉘고 재계산 뒤에도 같은 자리에서 나뉜다.
    """
    u, v = frame(canonical_axis(normal))

    def at(cos: float, sin: float) -> Vec:
        x, y, z = (center[i] + radius * (u[i] * cos + v[i] * sin) for i in range(3))
        return (x, y, z)

    p0, p90, p180, p270 = at(1, 0), at(0, 1), at(-1, 0), at(0, -1)
    return Edge(start=p0, mid=p90, end=p180), Edge(start=p180, mid=p270, end=p0)


def seam(a: Vec, b: Vec) -> Edge:
    """반쪽 원기둥 사이의 이음선: 두 원의 같은 각도 점을 잇는 직선"""
    return Edge(start=a, mid=((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), end=b)
