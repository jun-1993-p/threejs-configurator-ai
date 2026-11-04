"""경계 맞춤 격자(ADR-0016). 면의 점을 경계 모서리에 맞춰 두고, 연결은 기본 형상에서 한 번 정한다.

- 경계 점: 모서리마다 길이로 나눈 비율 위치. 나누는 수는 모서리 하나로만 정하므로,
  같은 모서리를 공유하는 두 면은 그 모서리 위에 같은 점을 둔다.
- 안쪽 점: 기본 형상에서 경계 점만으로 면을 삼각형으로 나누고, 안쪽 점마다 감싸는 삼각형 안의
  비율(무게중심 좌표)을 기억한다. 다른 샘플에서는 그 삼각형의 경계 점을 따라 같은 비율로 놓는다.
  삼각형 꼭짓점이 모두 경계 위에 있으므로, 폭이 고정된 고리 모양 면에서도 점이 면 밖으로 나가지 않는다.
- 계산은 면의 2차원 좌표에서 한다. 평면은 면 위의 (u, v), 원기둥은 (각도 × 반지름, 높이)다.
"""

import math
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


def frame(normal: Vec) -> tuple[Vec, Vec]:
    """법선에 수직인 두 축. 법선과 가장 덜 평행한 월드 축을 첫 축으로 삼아 샘플마다 같게 한다."""
    n = _unit(normal)
    world = [(1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)]
    w = min(world, key=lambda a: abs(_dot(a, n)))
    u = _unit(_sub(w, _mul(n, _dot(w, n))))
    return u, _cross(n, u)


Vec2 = tuple[float, float]

# 원호 모서리는 이 각도마다 적어도 한 번 나눈다
MAX_ARC_STEP = math.radians(15)


@dataclass(frozen=True)
class Plane:
    normal: Vec


@dataclass(frozen=True)
class Cylinder:
    origin: Vec
    axis: Vec
    radius: float


Surface = Plane | Cylinder


@dataclass(frozen=True)
class PointSpec:
    """점 하나를 만드는 규칙. boundary는 모서리와 그 위의 비율, interior는 경계 점 셋과 무게중심 좌표."""

    kind: str
    edge: str = ""
    t: float = 0.0
    corners: tuple[int, int, int] = (0, 0, 0)
    weights: tuple[float, float, float] = (0.0, 0.0, 0.0)


@dataclass(frozen=True)
class FaceLayout:
    specs: list[PointSpec]
    triangles: list[tuple[int, int, int]]
    # 원기둥 면의 각도를 펼칠 때 자르는 각도. 평면은 쓰지 않는다.
    cut: float = 0.0


# --- 모서리 -------------------------------------------------------------------


@dataclass(frozen=True)
class _Arc:
    center: Vec
    x: Vec
    y: Vec
    radius: float
    sweep: float


def _arc(e: Edge) -> _Arc | None:
    """세 점이 한 직선 위에 있으면 None, 아니면 시작점에서 중간점을 지나 끝점까지의 원호."""
    s, m, end = e.start, e.mid, e.end
    a, b = _sub(m, s), _sub(end, s)
    n = _cross(a, b)
    nn = _dot(n, n)
    if nn < _EPS * max(_dot(a, a), _dot(b, b), 1.0) ** 2:
        return None
    center = _add(s, _mul(_add(_mul(_cross(n, a), _dot(b, b)), _mul(_cross(b, n), _dot(a, a))), 0.5 / nn))
    normal = _unit(n)
    rs = _sub(s, center)
    radius = math.sqrt(_dot(rs, rs))
    x = _unit(rs)
    y = _cross(normal, x)
    ve = _sub(end, center)
    sweep = math.atan2(_dot(ve, y), _dot(ve, x)) % (2 * math.pi) or 2 * math.pi
    return _Arc(center=center, x=x, y=y, radius=radius, sweep=sweep)


def edge_length(e: Edge) -> float:
    arc = _arc(e)
    if arc is None:
        d = _sub(e.end, e.start)
        return math.sqrt(_dot(d, d))
    return arc.radius * arc.sweep


def edge_point(e: Edge, t: float) -> Vec:
    arc = _arc(e)
    if arc is None:
        return _add(e.start, _mul(_sub(e.end, e.start), t))
    a = arc.sweep * t
    return _add(arc.center, _mul(_add(_mul(arc.x, math.cos(a)), _mul(arc.y, math.sin(a))), arc.radius))


def edge_segments(e: Edge, spacing: float) -> int:
    """모서리를 나누는 수. 모서리 하나로만 정해진다."""
    count = max(1, math.ceil(edge_length(e) / spacing - 1e-9))
    arc = _arc(e)
    if arc is not None:
        count = max(count, math.ceil(arc.sweep / MAX_ARC_STEP - 1e-9))
    return count


# --- 면의 2차원 좌표 ----------------------------------------------------------


class _Chart:
    def __init__(self, surface: Surface, anchor: Vec, cut: float) -> None:
        self.surface = surface
        if isinstance(surface, Plane):
            n = _unit(surface.normal)
            self.u, self.v = frame(n)
            self.origin = _mul(n, _dot(anchor, n))
        else:
            self.k = _unit(surface.axis)
            self.e1, self.e2 = frame(self.k)
            self.cut = cut

    def to2d(self, p: Vec) -> Vec2:
        if isinstance(self.surface, Plane):
            d = _sub(p, self.origin)
            return (_dot(d, self.u), _dot(d, self.v))
        rel = _sub(p, self.surface.origin)
        theta = math.atan2(_dot(rel, self.e2), _dot(rel, self.e1))
        theta = self.cut + (theta - self.cut) % (2 * math.pi)
        return (theta * self.surface.radius, _dot(rel, self.k))

    def to3d(self, q: Vec2) -> Vec:
        if isinstance(self.surface, Plane):
            return _add(self.origin, _add(_mul(self.u, q[0]), _mul(self.v, q[1])))
        theta = q[0] / self.surface.radius
        radial = _add(_mul(self.e1, math.cos(theta)), _mul(self.e2, math.sin(theta)))
        return _add(self.surface.origin, _add(_mul(self.k, q[1]), _mul(radial, self.surface.radius)))


def _cylinder_cut(surface: Cylinder, points: list[Vec]) -> float:
    """원기둥 면의 경계 각도들 사이 가장 큰 빈틈의 한가운데. 여기서 각도를 잘라 펼친다."""
    k = _unit(surface.axis)
    e1, e2 = frame(k)
    angles = sorted(
        math.atan2(_dot(_sub(p, surface.origin), e2), _dot(_sub(p, surface.origin), e1)) % (2 * math.pi)
        for p in points
    )
    gaps = [((angles[(i + 1) % len(angles)] - angles[i]) % (2 * math.pi), i) for i in range(len(angles))]
    gap, i = max(gaps)
    return angles[i] + gap / 2


# --- 2차원 삼각형 나누기 ------------------------------------------------------


def _cross2(o: Vec2, a: Vec2, b: Vec2) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _signed_area(loop: list[int], pts: list[Vec2]) -> float:
    return sum(_cross2((0.0, 0.0), pts[loop[i]], pts[loop[(i + 1) % len(loop)]]) for i in range(len(loop))) / 2


def _strictly_inside(p: Vec2, a: Vec2, b: Vec2, c: Vec2, tol: float) -> bool:
    return _cross2(a, b, p) > tol and _cross2(b, c, p) > tol and _cross2(c, a, p) > tol


def _seg_hit_x(p: Vec2, a: Vec2, b: Vec2) -> float | None:
    """p에서 +x 방향 반직선이 선분 ab와 만나는 x. 만나지 않으면 None."""
    if (a[1] > p[1]) == (b[1] > p[1]):
        return None
    x = a[0] + (p[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
    return x if x >= p[0] - _EPS else None


def _bridge(outer: list[int], hole: list[int], pts: list[Vec2]) -> list[int]:
    """구멍을 바깥 고리에 이어 붙여 하나의 고리로 만든다(구멍의 가장 오른쪽 점에서 보이는 바깥 점으로)."""
    m_pos = max(range(len(hole)), key=lambda i: (pts[hole[i]][0], -pts[hole[i]][1]))
    m = pts[hole[m_pos]]
    best: tuple[float, int] | None = None
    for i in range(len(outer)):
        a, b = pts[outer[i]], pts[outer[(i + 1) % len(outer)]]
        x = _seg_hit_x(m, a, b)
        if x is not None and (best is None or x < best[0]):
            best = (x, i if a[0] > b[0] else (i + 1) % len(outer))
    if best is None:
        raise ValueError("구멍을 바깥 경계에 이을 수 없습니다")
    hit_x, p_pos = best
    p = pts[outer[p_pos]]
    # 이음선 삼각형 안에 바깥 고리의 점이 있으면 그중 각도가 가장 작은 점으로 잇는다
    hit = (hit_x, m[1])
    tol = 1e-12
    candidates = [
        j
        for j in range(len(outer))
        if outer[j] != outer[p_pos]
        and pts[outer[j]][0] >= m[0]
        and (_strictly_inside(pts[outer[j]], m, hit, p, -tol) or _strictly_inside(pts[outer[j]], m, p, hit, -tol))
    ]
    if candidates:
        p_pos = min(
            candidates,
            key=lambda j: (
                abs(math.atan2(pts[outer[j]][1] - m[1], pts[outer[j]][0] - m[0])),
                (pts[outer[j]][0] - m[0]) ** 2 + (pts[outer[j]][1] - m[1]) ** 2,
            ),
        )
    rotated = hole[m_pos:] + hole[:m_pos]
    return outer[: p_pos + 1] + rotated + [hole[m_pos], outer[p_pos]] + outer[p_pos + 1 :]


def _earcut(poly: list[int], pts: list[Vec2]) -> list[tuple[int, int, int]]:
    """반시계 방향 단순 다각형(이음선으로 구멍을 이은 것 포함)의 귀 자르기.

    자를 수 있는 귀 중 대각선이 가장 짧은 귀부터 자른다. 그래야 폭이 좁은 띠에서 삼각형이 띠의 양쪽 변만
    잇게 되어, 띠의 길이가 바뀌어도 삼각형이 뒤집히지 않는다.
    """
    scale = max(max(abs(pts[i][0]), abs(pts[i][1])) for i in poly) or 1.0
    tol = 1e-12 * scale * scale
    ring = list(poly)
    tris: list[tuple[int, int, int]] = []
    while len(ring) > 3:
        n = len(ring)
        reflex = [
            v for k, v in enumerate(ring) if _cross2(pts[ring[(k - 1) % n]], pts[v], pts[ring[(k + 1) % n]]) <= tol
        ]
        best: tuple[float, int] | None = None
        for i in range(n):
            a, b, c = ring[(i - 1) % n], ring[i], ring[(i + 1) % n]
            pa, pb, pc = pts[a], pts[b], pts[c]
            if _cross2(pa, pb, pc) <= tol:
                continue
            diagonal = (pa[0] - pc[0]) ** 2 + (pa[1] - pc[1]) ** 2
            if best is not None and diagonal >= best[0]:
                continue
            # 대각선 ac 위에 놓인 점도 막는다(경계 위 일직선 점이 많아서 필요하다)
            blocked = any(
                v not in (a, b, c) and pts[v] not in (pa, pb, pc) and _strictly_inside(pts[v], pa, pb, pc, -tol)
                for v in reflex
            )
            if not blocked:
                best = (diagonal, i)
        if best is not None:
            i = best[1]
            tris.append((ring[(i - 1) % n], ring[i], ring[(i + 1) % n]))
            del ring[i]
        else:
            # 일직선 위의 점만 남은 자리: 넓이 없는 꼭짓점을 빼고 이어 간다
            flat = next(
                (i for i in range(n) if abs(_cross2(pts[ring[(i - 1) % n]], pts[ring[i]], pts[ring[(i + 1) % n]])) <= tol),
                None,
            )
            if flat is None:
                raise ValueError("면을 삼각형으로 나눌 수 없습니다")
            del ring[flat]
    if len(ring) == 3 and abs(_cross2(pts[ring[0]], pts[ring[1]], pts[ring[2]])) > tol:
        tris.append((ring[0], ring[1], ring[2]))
    return tris


def _barycentric(p: Vec2, a: Vec2, b: Vec2, c: Vec2) -> tuple[float, float, float]:
    d = _cross2(a, b, c)
    if abs(d) < 1e-300:
        return (-1.0, -1.0, 3.0)
    wa = _cross2(p, b, c) / d
    wb = _cross2(a, p, c) / d
    return (wa, wb, 1.0 - wa - wb)


def _contains(w: tuple[float, float, float]) -> bool:
    return min(w) >= -1e-9


def _dist_to_seg(p: Vec2, a: Vec2, b: Vec2) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    ll = dx * dx + dy * dy
    t = 0.0 if ll == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / ll))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


# --- 배치 만들기와 놓기 -------------------------------------------------------


def _loops(edges: dict[str, Edge], spacing: float) -> list[list[PointSpec]]:
    """모서리를 끝점으로 이어 고리로 만들고, 고리마다 경계 점 규칙을 순서대로 낸다."""
    scale = max(edge_length(e) for e in edges.values()) or 1.0
    tol = 1e-6 * scale

    def same(p: Vec, q: Vec) -> bool:
        d = _sub(p, q)
        return math.sqrt(_dot(d, d)) <= tol

    unused = dict(edges)
    loops = []
    while unused:
        name, e = next(iter(unused.items()))
        del unused[name]
        chain = [(name, e, True)]
        start, cur = e.start, e.end
        while not same(cur, start):
            nxt = next(((n, x, True) for n, x in unused.items() if same(x.start, cur)), None) or next(
                ((n, x, False) for n, x in unused.items() if same(x.end, cur)), None
            )
            if nxt is None:
                raise ValueError(f"모서리 {name}에서 시작한 경계가 닫히지 않습니다")
            del unused[nxt[0]]
            chain.append(nxt)
            cur = nxt[1].end if nxt[2] else nxt[1].start
        specs = []
        for n, x, forward in chain:
            k = edge_segments(x, spacing)
            for i in range(k):
                specs.append(PointSpec(kind="boundary", edge=n, t=i / k if forward else 1 - i / k))
        loops.append(specs)
    return loops


def _boundary_point(spec: PointSpec, edges: dict[str, Edge]) -> Vec:
    return edge_point(edges[spec.edge], spec.t)


def build_layout(surface: Surface, edges: dict[str, Edge], spacing: float) -> FaceLayout:
    """기본 형상의 면 하나에 대한 경계 맞춤 격자 배치."""
    loops = _loops(edges, spacing)
    specs = [s for loop in loops for s in loop]
    pts3 = [_boundary_point(s, edges) for s in specs]
    cut = _cylinder_cut(surface, pts3) if isinstance(surface, Cylinder) else 0.0
    chart = _Chart(surface, pts3[0], cut)
    pts = [chart.to2d(p) for p in pts3]

    index_loops, offset = [], 0
    for loop in loops:
        index_loops.append(list(range(offset, offset + len(loop))))
        offset += len(loop)
    index_loops.sort(key=lambda lp: -abs(_signed_area(lp, pts)))
    outer, holes = index_loops[0], index_loops[1:]
    if _signed_area(outer, pts) < 0:
        outer.reverse()
    for h in holes:
        if _signed_area(h, pts) > 0:
            h.reverse()
    poly = outer
    for h in sorted(holes, key=lambda lp: -max(pts[i][0] for i in lp)):
        poly = _bridge(poly, h, pts)
    boundary_tris = _earcut(poly, pts)

    # 안쪽 점: 간격 spacing의 격자 중 경계에서 spacing/4보다 먼 점
    segments = [(pts[lp[i]], pts[lp[(i + 1) % len(lp)]]) for lp in index_loops for i in range(len(lp))]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    nx = max(0, math.floor((max(xs) - min(xs)) / spacing))
    ny = max(0, math.floor((max(ys) - min(ys)) / spacing))
    x0 = (min(xs) + max(xs)) / 2 - nx * spacing / 2
    y0 = (min(ys) + max(ys)) / 2 - ny * spacing / 2
    tris = list(boundary_tris)
    for i in range(nx + 1):
        for j in range(ny + 1):
            q = (x0 + i * spacing, y0 + j * spacing)
            host = next(
                (t for t in boundary_tris if _contains(_barycentric(q, pts[t[0]], pts[t[1]], pts[t[2]]))), None
            )
            if host is None or min(_dist_to_seg(q, a, b) for a, b in segments) < spacing / 4:
                continue
            w = _barycentric(q, pts[host[0]], pts[host[1]], pts[host[2]])
            new = len(pts)
            specs.append(PointSpec(kind="interior", corners=host, weights=w))
            pts.append(q)
            # 연결: 이 점을 감싸는 삼각형을 나눈다. 변 위에 놓이면 그 변을 가진 두 삼각형을 모두 나눈다.
            hosts = [t for t in tris if _contains(_barycentric(q, pts[t[0]], pts[t[1]], pts[t[2]]))]
            for t in hosts:
                tris.remove(t)
                a, b, c = t
                tris += [
                    child
                    for child in ((a, b, new), (b, c, new), (c, a, new))
                    if abs(_cross2(pts[child[0]], pts[child[1]], pts[child[2]])) > 1e-9 * spacing * spacing
                ]
    return FaceLayout(specs=specs, triangles=tris, cut=cut)


def place(layout: FaceLayout, surface: Surface, edges: dict[str, Edge]) -> list[Vec]:
    """배치를 한 샘플의 면에 놓는다. 점 수와 순서는 배치가 정한다."""
    boundary = [_boundary_point(s, edges) for s in layout.specs if s.kind == "boundary"]
    chart = _Chart(surface, boundary[0], layout.cut)
    flat = [chart.to2d(p) for p in boundary]
    out = list(boundary)
    for s in layout.specs[len(boundary) :]:
        (a, b, c), (wa, wb, wc) = s.corners, s.weights
        q = (wa * flat[a][0] + wb * flat[b][0] + wc * flat[c][0], wa * flat[a][1] + wb * flat[b][1] + wc * flat[c][1])
        out.append(chart.to3d(q))
    return out

