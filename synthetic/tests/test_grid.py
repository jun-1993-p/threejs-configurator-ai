import math

import pytest

from synthetic.grid import Edge, cylinder_grid, plane_grid


def _line(a: tuple[float, float, float], b: tuple[float, float, float]) -> Edge:
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
    return Edge(start=a, mid=mid, end=b)


def _rect(x0: float, y0: float, x1: float, y1: float, z: float) -> list[Edge]:
    c = [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]
    return [_line(c[i], c[(i + 1) % 4]) for i in range(4)]


def test_평면은_경계_범위에_n곱하기n_점을_찍는다() -> None:
    points = plane_grid((0.0, 0.0, 1.0), _rect(0, 0, 200, 100, 20), 3)

    assert len(points) == 9
    assert {p[2] for p in points} == {20.0}
    xs = sorted({round(p[0], 9) for p in points})
    ys = sorted({round(p[1], 9) for p in points})
    assert xs == [0.0, 100.0, 200.0]
    assert ys == [0.0, 50.0, 100.0]


def test_평면의_점_순서는_샘플마다_같은_규칙이다() -> None:
    a = plane_grid((0.0, 0.0, 1.0), _rect(0, 0, 200, 100, 0), 3)
    b = plane_grid((0.0, 0.0, 1.0), _rect(0, 0, 400, 100, 0), 3)

    # 같은 번호의 점은 같은 (u,v) 비율에 있다
    assert [(p[0] / 200, p[1]) for p in a] == [(p[0] / 400, p[1]) for p in b]


def test_구멍이_있는_평면은_바깥_경계_범위로_격자를_깐다() -> None:
    edges = _rect(-280, 0, 280, 430, 220) + _rect(-262, 18, 262, 412, 220)

    points = plane_grid((0.0, 0.0, 1.0), edges, 5)

    assert min(p[0] for p in points) == pytest.approx(-280)
    assert max(p[1] for p in points) == pytest.approx(430)


def test_원호_경계는_원호의_가장_바깥_점까지_범위에_넣는다() -> None:
    # 반지름 50 원판을 반원 두 개로 나눈 경계. 이음매가 축에 맞지 않아도 범위는 지름 100이다.
    r, t0 = 50.0, math.radians(30)

    def at(t: float) -> tuple[float, float, float]:
        return (r * math.cos(t), r * math.sin(t), 0.0)

    edges = [
        Edge(start=at(t0), mid=at(t0 + math.pi / 2), end=at(t0 + math.pi)),
        Edge(start=at(t0 + math.pi), mid=at(t0 + 3 * math.pi / 2), end=at(t0)),
    ]

    points = plane_grid((0.0, 0.0, 1.0), edges, 3)

    assert min(p[0] for p in points) == pytest.approx(-50)
    assert max(p[0] for p in points) == pytest.approx(50)
    assert min(p[1] for p in points) == pytest.approx(-50)
    assert max(p[1] for p in points) == pytest.approx(50)


def test_반원기둥은_각도와_높이_범위에_격자를_깐다() -> None:
    o, r = (0.0, 200.0, 0.0), 15.0

    def at(t: float, z: float) -> tuple[float, float, float]:
        return (o[0] + r * math.cos(t), o[1] + r * math.sin(t), z)

    t0 = math.radians(35)
    edges = [
        Edge(start=at(t0, 0), mid=at(t0 + math.pi / 2, 0), end=at(t0 + math.pi, 0)),
        Edge(start=at(t0 + math.pi, 50), mid=at(t0 + math.pi / 2, 50), end=at(t0, 50)),
        _line(at(t0, 50), at(t0, 0)),
        _line(at(t0 + math.pi, 0), at(t0 + math.pi, 50)),
    ]

    points = cylinder_grid(o, (0.0, 0.0, 1.0), r, edges, 3)

    assert len(points) == 9
    for p in points:
        assert math.hypot(p[0] - o[0], p[1] - o[1]) == pytest.approx(r)
    assert sorted({round(p[2], 9) for p in points}) == [0.0, 25.0, 50.0]
    angles = sorted({round(math.degrees(math.atan2(p[1] - o[1], p[0] - o[0])) % 360, 6) for p in points})
    assert angles == pytest.approx([35.0, 125.0, 215.0])


def test_필렛_사분원기둥은_90도_범위에만_점을_찍는다() -> None:
    o, r = (10.0, 10.0, 0.0), 10.0

    def at(t: float, z: float) -> tuple[float, float, float]:
        return (o[0] + r * math.cos(t), o[1] + r * math.sin(t), z)

    edges = [
        Edge(start=at(math.pi, 0), mid=at(1.25 * math.pi, 0), end=at(1.5 * math.pi, 0)),
        _line(at(1.5 * math.pi, 0), at(1.5 * math.pi, 20)),
        Edge(start=at(1.5 * math.pi, 20), mid=at(1.25 * math.pi, 20), end=at(math.pi, 20)),
        _line(at(math.pi, 20), at(math.pi, 0)),
    ]

    points = cylinder_grid(o, (0.0, 0.0, -1.0), r, edges, 3)

    for p in points:
        assert p[0] <= o[0] + 1e-9 and p[1] <= o[1] + 1e-9
    assert len({(round(p[0], 6), round(p[1], 6)) for p in points}) == 3
