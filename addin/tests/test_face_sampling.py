import math

from uploader.face_names import EdgeRole, edge_names
from uploader.face_sampling import FaceSampler, FaceSurface, canonical_axis, seam, split_circle, spacing_for
from uploader.fitted import Cylinder, Edge, Plane


def _round_leg(radius: float, height: float, axis_sign: float) -> tuple[list[FaceSurface], dict[str, Edge]]:
    """이음선 없는 원기둥(둥근 다리)과 위·아래 원판을 Fusion 어댑터처럼 반쪽 원기둥과 반원으로 나눈다."""
    top = split_circle((0.0, 0.0, height), (0.0, 0.0, axis_sign), radius)
    bottom = split_circle((0.0, 0.0, 0.0), (0.0, 0.0, -axis_sign), radius)
    cylinder = Cylinder(origin=(0.0, 0.0, 0.0), axis=canonical_axis((0.0, 0.0, axis_sign)), radius=radius)
    faces = [
        FaceSurface("leg:half1", cylinder),
        FaceSurface("leg:half2", cylinder),
        FaceSurface("top", Plane(normal=(0.0, 0.0, 1.0))),
        FaceSurface("bottom", Plane(normal=(0.0, 0.0, -1.0))),
    ]
    edges = [
        (EdgeRole("top", "leg:half1", ()), top[0]),
        (EdgeRole("top", "leg:half2", ()), top[1]),
        (EdgeRole("bottom", "leg:half1", ()), bottom[0]),
        (EdgeRole("bottom", "leg:half2", ()), bottom[1]),
        (EdgeRole("leg:half1", "leg:half2", (0.0,)), seam(bottom[0].start, top[0].start)),
        (EdgeRole("leg:half1", "leg:half2", (1.0,)), seam(bottom[0].end, top[0].end)),
    ]
    names = edge_names([role for role, _ in edges])
    return faces, {name: edge for name, (_, edge) in zip(names, edges)}


def test_이음선_없는_원기둥을_반쪽_둘로_나누면_점이_표면_위에_놓이고_샘플끼리_점_수가_같다() -> None:
    sampler = FaceSampler()
    spacing = spacing_for(math.dist((-10, -10, 0), (10, 10, 30)), 9)
    counts = []
    for radius, height in ((10.0, 30.0), (14.0, 45.0)):
        faces, edges = _round_leg(radius, height, 1.0)
        samples = sampler.sample("leg", spacing, faces, edges)
        counts.append([len(s.points) for s in samples])
        for s in samples:
            for x, y, z in s.points:
                if s.surface == "cylinder":
                    assert abs(math.hypot(x, y) - radius) < 1e-9
                    assert -1e-9 <= z <= height + 1e-9
                else:
                    assert abs(z - (height if s.name == "top" else 0.0)) < 1e-9
                    assert math.hypot(x, y) <= radius + 1e-9
    assert counts[0] == counts[1]
    assert all(c > 0 for c in counts[0])


def test_축_부호가_뒤집혀도_원은_같은_자리에서_나뉜다() -> None:
    up = split_circle((1.0, 2.0, 3.0), (0.0, 0.0, 1.0), 5.0)
    down = split_circle((1.0, 2.0, 3.0), (0.0, 0.0, -1.0), 5.0)

    assert up == down
    assert canonical_axis((0.0, -2.0, 0.5)) == canonical_axis((0.0, 2.0, -0.5))
