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
