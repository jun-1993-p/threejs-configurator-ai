"""SolidCraft 면의 매개변수 범위 격자. SolidCraft에는 (u,v) → 좌표 계산이 없어서 직접 계산한다.

Fusion 애드인의 `_grid_points`와 같은 형식(n×n, u 바깥 반복·v 안쪽 반복)을 낸다.
범위는 경계 모서리의 시작·중간·끝점으로 정하고, 원호 모서리는 가장 바깥 점까지 넣는다.
트림된 면에서는 일부 점이 면 밖의 표면 위에 찍힌다. 경계 맞춤 격자는 티켓 25에서 한다.
"""

import math
from collections.abc import Iterable
from dataclasses import dataclass

Vec = tuple[float, float, float]

_EPS = 1e-9


@dataclass(frozen=True)
class Edge:
    start: Vec
    mid: Vec
    end: Vec


def _sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _add(a: Vec, b: Vec) -> Vec:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _mul(a: Vec, k: float) -> Vec:
    return (a[0] * k, a[1] * k, a[2] * k)


def _dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a: Vec, b: Vec) -> Vec:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _unit(a: Vec) -> Vec:
    return _mul(a, 1.0 / math.sqrt(_dot(a, a)))


def _frame(normal: Vec) -> tuple[Vec, Vec]:
    """법선에 수직인 두 축. 법선과 가장 덜 평행한 월드 축을 첫 축으로 삼아 샘플마다 같게 한다."""
    n = _unit(normal)
    world = [(1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)]
    w = min(world, key=lambda a: abs(_dot(a, n)))
    u = _unit(_sub(w, _mul(n, _dot(w, n))))
    return u, _cross(n, u)


def _arc_extremes(edge: Edge, directions: Iterable[Vec]) -> list[Vec]:
    """원호 모서리 위에서 주어진 방향으로 가장 먼 점들. 직선이면 빈 목록."""
    s, m, e = edge.start, edge.mid, edge.end
    a, b = _sub(m, s), _sub(e, s)
    n = _cross(a, b)
    nn = _dot(n, n)
    normal: Vec | None
    if _dot(b, b) < _EPS and _dot(a, a) > _EPS:
        # 닫힌 원: 시작점과 끝점이 같으면 중간점이 지름 반대편이다
        center = _mul(_add(s, m), 0.5)
        normal = None
    elif nn < _EPS * max(_dot(a, a), _dot(b, b), 1.0) ** 2:
        return []
    else:
        # 세 점을 지나는 원의 중심
        center = _add(s, _mul(_add(_mul(_cross(n, a), _dot(b, b)), _mul(_cross(b, n), _dot(a, a))), 0.5 / nn))
        normal = _unit(n)
    r = math.sqrt(_dot(_sub(s, center), _sub(s, center)))
    out = []
    for d in directions:
        if normal is None:
            out += [_add(center, _mul(_unit(d), r)), _sub(center, _mul(_unit(d), r))]
            continue
        dp = _sub(d, _mul(normal, _dot(d, normal)))
        if _dot(dp, dp) < _EPS:
            continue
        dp = _unit(dp)
        x = _unit(_sub(s, center))
        y = _cross(normal, x)

        def angle(p: Vec) -> float:
            v = _sub(p, center)
            return math.atan2(_dot(v, y), _dot(v, x)) % (2 * math.pi)

        sweep = angle(e) or 2 * math.pi
        for sign in (1.0, -1.0):
            p = _add(center, _mul(dp, sign * r))
            if angle(p) <= sweep + _EPS:
                out.append(p)
    return out


def _edge_points(edges: Iterable[Edge], directions: list[Vec]) -> list[Vec]:
    points: list[Vec] = []
    for e in edges:
        points += [e.start, e.mid, e.end] + _arc_extremes(e, directions)
    return points


def _steps(lo: float, hi: float, n: int) -> list[float]:
    return [lo + (hi - lo) * i / (n - 1) for i in range(n)]


def plane_grid(normal: Vec, edges: list[Edge], n: int) -> list[Vec]:
    """평면 면의 경계 범위에 n×n 점을 찍는다."""
    u, v = _frame(normal)
    origin = _mul(_unit(normal), _dot(edges[0].start, _unit(normal)))
    points = _edge_points(edges, [u, v])
    us = [_dot(_sub(p, origin), u) for p in points]
    vs = [_dot(_sub(p, origin), v) for p in points]
    return [
        _add(origin, _add(_mul(u, pu), _mul(v, pv)))
        for pu in _steps(min(us), max(us), n)
        for pv in _steps(min(vs), max(vs), n)
    ]


def _angle_range(angles: list[float]) -> tuple[float, float]:
    """원 위의 각도들을 덮는 가장 짧은 호. 가장 큰 빈틈의 반대쪽이다."""
    a = sorted(x % (2 * math.pi) for x in angles)
    gaps = [(a[(i + 1) % len(a)] - a[i]) % (2 * math.pi) for i in range(len(a))]
    i = max(range(len(a)), key=lambda k: gaps[k])
    start = a[(i + 1) % len(a)]
    return start, start + (2 * math.pi - gaps[i])


def cylinder_grid(origin: Vec, axis: Vec, radius: float, edges: list[Edge], n: int) -> list[Vec]:
    """원기둥 면의 각도·축 방향 범위에 n×n 점을 찍는다. u는 각도, v는 축 방향."""
    k = _unit(axis)
    e1, e2 = _frame(k)
    points = _edge_points(edges, [])
    rel = [_sub(p, origin) for p in points]
    t0, t1 = _angle_range([math.atan2(_dot(p, e2), _dot(p, e1)) for p in rel])
    hs = [_dot(p, k) for p in rel]
    return [
        _add(origin, _add(_mul(k, h), _mul(_add(_mul(e1, math.cos(t)), _mul(e2, math.sin(t))), radius)))
        for t in _steps(t0, t1, n)
        for h in _steps(min(hs), max(hs), n)
    ]
