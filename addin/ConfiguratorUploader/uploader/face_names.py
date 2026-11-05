"""면·모서리 이름 문법(ADR-0016). 이름을 짓는 쪽(Fusion 어댑터)과 나누는 쪽(edge_faces)을 한곳에 둔다.

- 면 이름: 피처와 그 안의 역할(돌출1:start, 돌출1:side:2). 같은 바디에 같은 이름이 여럿이면 `:순번`.
- 모서리 이름: 사이에 둔 두 면 이름 쌍 "면A|면B"(이름 순). 같은 쌍이 여럿이면 "~순번".

Fusion은 옆면 순서를 재계산마다 바꾸고 tempId도 바꾸므로, 어댑터는 기본 형상에서 지은 이름을 면 표시로
붙여 두고 다른 샘플에서는 표시를 읽는다(티켓 26 1절 탐색). 표시가 겹치는 면(갈라짐)은 `:split순번`,
표시가 없는 면(새 면)은 `:new순번`을 받아, 서버가 위상 변화로 알아본다.
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass

Order = tuple[float, ...]


@dataclass(frozen=True)
class FaceRole:
    """면 하나의 이름 재료. tag는 기본 형상에서 붙인 이름, order는 같은 이름이 여럿일 때 순번을 정하는 열쇠."""

    feature: str
    role: str
    order: Order
    tag: str | None = None

    def fresh_name(self) -> str:
        # 모서리 이름이 "|"로 두 면을, "~"로 순번을 가르므로 면 이름에는 쓰지 않는다.
        name = f"{self.feature}:{self.role}" if self.feature else self.role
        return name.replace("|", "_").replace("~", "_")


@dataclass(frozen=True)
class EdgeRole:
    """모서리 하나의 이름 재료: 양쪽 면 이름과 같은 쌍이 여럿일 때 순번을 정하는 열쇠"""

    face_a: str
    face_b: str
    order: Order


def _numbered(keys: Sequence[str], orders: Sequence[Order], label: Callable[[str, int], str], always: bool) -> list[str]:
    """같은 열쇠가 여럿이면 order 순으로 label(열쇠, 순번)을 쓴다. always면 하나여도 쓴다."""
    out = list(keys)
    groups: dict[str, list[int]] = {}
    for i, key in enumerate(keys):
        groups.setdefault(key, []).append(i)
    for key, members in groups.items():
        if len(members) == 1 and not always:
            continue
        for k, i in enumerate(sorted(members, key=lambda j: orders[j]), start=1):
            out[i] = label(key, k)
    return out


def face_names(faces: Sequence[FaceRole], baseline: bool) -> list[str]:
    """바디 하나의 면 이름. baseline이면 표시를 보지 않고 새로 짓는다."""
    if baseline:
        return _numbered([f.fresh_name() for f in faces], [f.order for f in faces], lambda n, k: f"{n}:{k}", False)
    names = [""] * len(faces)
    tagged = [i for i, f in enumerate(faces) if f.tag is not None]
    fresh = [i for i, f in enumerate(faces) if f.tag is None]
    split = _numbered(
        [faces[i].tag or "" for i in tagged], [faces[i].order for i in tagged], lambda n, k: f"{n}:split{k}", False
    )
    new = _numbered(
        [faces[i].fresh_name() for i in fresh], [faces[i].order for i in fresh], lambda n, k: f"{n}:new{k}", True
    )
    for i, name in [*zip(tagged, split), *zip(fresh, new)]:
        names[i] = name
    return names


def body_name(face_tags: Sequence[str | None]) -> str | None:
    """바디의 면마다 붙인 기본 형상의 바디 이름 중 가장 많은 것(같으면 이름 순으로 앞의 것). 없으면 None.

    Fusion은 재계산 뒤 바디를 새로 만들어 바디 이름과 바디에 붙인 속성을 잃기도 하지만, 면 표시는 남는다(티켓 26 4절).
    그래서 바디 이름도 면에 붙여 둔다. 바디가 합쳐지면 면마다 다를 수 있다.
    """
    counts: dict[str, int] = {}
    for tag in face_tags:
        if tag is not None:
            counts[tag] = counts.get(tag, 0) + 1
    return min(counts, key=lambda name: (-counts[name], name)) if counts else None


@dataclass(frozen=True)
class BodyTag:
    """바디 하나의 이름 재료: 면의 바디 표시에서 고른 이름(body_name), 그 이름이 붙은 면 수, Fusion의 바디 이름"""

    tag: str | None
    tagged_faces: int
    fusion: str


def body_names(bodies: Sequence[BodyTag]) -> tuple[list[str], list[str]]:
    """한 부품(또는 루트) 안 바디들의 이름과, 표시를 쓰지 못해 Fusion 이름으로 돌린 바디의 Fusion 이름 목록.

    잘라내기로 바디 하나가 둘이 되면 두 조각의 면이 같은 표시를 물려받는다. 이름이 겹치면 면 샘플이 섞이므로
    표시된 면이 가장 많은 바디(같으면 앞의 것)만 그 이름을 쓰고 나머지는 Fusion 이름으로 돌린다. Fusion 이름이
    다른 바디의 표시와 겹치면 `:new`를 붙인다.
    """
    owner: dict[str, int] = {}
    for i, b in enumerate(bodies):
        if b.tag is not None and (b.tag not in owner or b.tagged_faces > bodies[owner[b.tag]].tagged_faces):
            owner[b.tag] = i
    names = [b.tag if b.tag is not None and owner[b.tag] == i else "" for i, b in enumerate(bodies)]
    fallback = []
    for i, b in enumerate(bodies):
        if not names[i]:
            fallback.append(b.fusion)
            names[i] = f"{b.fusion}:new" if b.fusion in owner else b.fusion
    return names, fallback


def edge_names(edges: Sequence[EdgeRole]) -> list[str]:
    pairs = ["|".join(sorted((e.face_a, e.face_b))) for e in edges]
    return _numbered(pairs, [e.order for e in edges], lambda n, k: f"{n}~{k}", False)


def edge_faces(edge_name: str, face_names: set[str]) -> tuple[str, str]:
    """모서리 이름 "면A|면B" 또는 "면A|면B~순번"을 두 면 이름으로 나눈다.

    필렛 면 이름(F3:blend:F1:-x|F1:-y)에도 세로선이 있으므로, 나눈 두 쪽이 모두 면 이름인 자리를 찾는다.
    """
    base = edge_name.rsplit("~", 1)[0] if "~" in edge_name else edge_name
    for i, ch in enumerate(base):
        if ch == "|" and base[:i] in face_names and base[i + 1 :] in face_names:
            return base[:i], base[i + 1 :]
    raise ValueError(f"모서리 {edge_name}: 두 면 이름으로 나눌 수 없습니다")
