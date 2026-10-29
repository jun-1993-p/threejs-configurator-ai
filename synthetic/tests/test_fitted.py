import math

import pytest

from synthetic.fitted import Cylinder, Plane, build_layout, place
from synthetic.fitted import Edge

Vec = tuple[float, float, float]


def _line(a: Vec, b: Vec) -> Edge:
    return Edge(start=a, mid=((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), end=b)


def _rect(name: str, x0: float, y0: float, x1: float, y1: float, z: float) -> dict[str, Edge]:
    c = [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]
    return {f"{name}{i}": _line(c[i], c[(i + 1) % 4]) for i in range(4)}


def _ring(depth: float) -> dict[str, Edge]:
    """서랍 윗테두리처럼 폭 18 mm 고리 모양 면. depth가 바뀌어도 테두리 폭은 그대로다."""
    return _rect("out", -280, 0, 280, depth, 220) | _rect("in", -262, 18, 262, depth - 18, 220)


def _inside_ring(p: Vec, depth: float) -> bool:
    x, y = p[0], p[1]
    tol = 1e-6
    in_outer = -280 - tol <= x <= 280 + tol and -tol <= y <= depth + tol
    in_hole = -262 + tol < x < 262 - tol and 18 + tol < y < depth - 18 - tol
    return in_outer and not in_hole


def _area(points: list[Vec], tris: list[tuple[int, int, int]]) -> float:
    total = 0.0
    for a, b, c in tris:
        pa, pb, pc = points[a], points[b], points[c]
        total += abs((pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1])) / 2
    return total


PLANE = Plane(normal=(0.0, 0.0, 1.0))


def test_직사각형_면의_삼각형은_면_전체를_빈틈없이_덮는다() -> None:
    edges = _rect("e", 0, 0, 200, 100, 0)

    layout = build_layout(PLANE, edges, spacing=30)
    points = place(layout, PLANE, edges)

    assert _area(points, layout.triangles) == pytest.approx(200 * 100)
    assert any(s.kind == "interior" for s in layout.specs)


def test_면이_늘어나도_점_수와_순서가_같고_안쪽_점도_따라간다() -> None:
    base = _rect("e", 0, 0, 200, 100, 0)
    layout = build_layout(PLANE, base, spacing=30)

    wide = place(layout, PLANE, _rect("e", 0, 0, 400, 100, 0))
    narrow = place(layout, PLANE, base)

    assert len(wide) == len(narrow)
    for a, b in zip(narrow, wide, strict=True):
        assert b[0] == pytest.approx(2 * a[0])
        assert b[1] == pytest.approx(a[1])


@pytest.mark.parametrize("depth", [205.0, 430.0, 655.0])
def test_고리_모양_면은_깊이가_바뀌어도_점_수가_같고_모든_점이_면_안에_있다(depth: float) -> None:
    layout = build_layout(PLANE, _ring(430.0), spacing=20)

    points = place(layout, PLANE, _ring(depth))

    assert len(points) == len(layout.specs)
    assert all(_inside_ring(p, depth) for p in points)
    ring_area = 560 * depth - 524 * (depth - 36)
    assert _area(points, layout.triangles) == pytest.approx(ring_area)


def test_고리_모양_면의_점은_깊이_방향으로만_움직인다() -> None:
    layout = build_layout(PLANE, _ring(430.0), spacing=20)

    a = place(layout, PLANE, _ring(430.0))
    b = place(layout, PLANE, _ring(655.0))

    assert max(abs(p[0] - q[0]) for p, q in zip(a, b, strict=True)) < 1e-9
    assert max(abs(p[2] - q[2]) for p, q in zip(a, b, strict=True)) < 1e-9


def test_공유_모서리의_점은_모서리만으로_정해진다() -> None:
    # 같은 모서리를 가진 두 면은 그 모서리 위에 같은 점을 둔다
    shared = _line((0, 0, 0), (100, 0, 0))
    top = _rect("t", 0, 0, 100, 50, 0) | {"t0": shared}
    big = _rect("b", 0, -300, 100, 0, 0) | {"b2": Edge(start=shared.end, mid=shared.mid, end=shared.start)}

    a = build_layout(PLANE, top, spacing=10)
    b = build_layout(PLANE, big, spacing=10)

    on_shared_a = sorted(round(p[0], 9) for p in place(a, PLANE, top) if abs(p[1]) < 1e-9)
    on_shared_b = sorted(round(p[0], 9) for p in place(b, PLANE, big) if abs(p[1]) < 1e-9)
    assert on_shared_a == on_shared_b


def _half_cylinder(radius: float, height: float) -> tuple[Cylinder, dict[str, Edge]]:
    o = (0.0, 0.0, 0.0)
    cyl = Cylinder(origin=o, axis=(0.0, 0.0, 1.0), radius=radius)
    t0 = math.radians(35)

    def at(t: float, z: float) -> Vec:
        return (radius * math.cos(t), radius * math.sin(t), z)

    edges = {
        "bottom": Edge(start=at(t0, 0), mid=at(t0 + math.pi / 2, 0), end=at(t0 + math.pi, 0)),
        "top": Edge(start=at(t0 + math.pi, height), mid=at(t0 + math.pi / 2, height), end=at(t0, height)),
        "seam0": _line(at(t0, height), at(t0, 0)),
        "seam1": _line(at(t0 + math.pi, 0), at(t0 + math.pi, height)),
    }
    return cyl, edges


def test_원기둥_면의_점은_모두_원기둥_위에_있고_반지름이_바뀌어도_수가_같다() -> None:
    cyl, edges = _half_cylinder(15.0, 50.0)
    layout = build_layout(cyl, edges, spacing=5)

    for radius in (15.0, 30.0):
        c, e = _half_cylinder(radius, 50.0)
        points = place(layout, c, e)
        assert len(points) == len(layout.specs)
        for p in points:
            assert math.hypot(p[0], p[1]) == pytest.approx(radius)
            assert -1e-9 <= p[2] <= 50.0 + 1e-9
    assert any(s.kind == "interior" for s in layout.specs)
