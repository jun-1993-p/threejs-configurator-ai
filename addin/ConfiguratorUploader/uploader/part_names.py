"""부품(오커런스) 이름. 재계산으로 인스턴스 번호가 바뀌어도 같은 부품은 같은 이름이어야 한다(ADR-0006).

Fusion의 오커런스 전체 경로(`구성요소1:12`)에는 인스턴스 번호가 든다. 패턴이 만든 인스턴스는 재계산마다 다시 만들어져
번호가 바뀌므로(`:12` → `:16`) 그 경로를 부품 이름으로 쓰면 부품이 사라지고 새로 생긴 것으로 보여 스위프 범위가 전부 줄었다
(티켓 26 2절 선반 업로드). 그래서 번호를 떼고 같은 컴포넌트끼리 위치 순서로 순번을 붙인다.
"""

import re
from collections.abc import Sequence

Position = tuple[float, float, float]

_INSTANCE_NUMBER = re.compile(r":\d+$")
# 위치는 소수 여섯째 자리까지만 견준다. 같은 곳에 있는 두 부품이 부동소수 잡음으로 순서가 뒤바뀌지 않게 한다.
_POSITION_DIGITS = 6


def stable_part_names(occurrences: Sequence[tuple[str, Position]]) -> list[str]:
    """(오커런스 전체 경로, 위치) 목록을 같은 순서의 부품 이름 목록으로 바꾼다. 이름은 `컴포넌트 경로#순번`이다.

    순번은 같은 컴포넌트 경로끼리 위치(x, y, z) 순서다. 위치가 같으면 주어진 순서를 따른다.
    """
    components = ["+".join(_INSTANCE_NUMBER.sub("", step) for step in path.split("+")) for path, _ in occurrences]
    names = [""] * len(occurrences)
    for component in dict.fromkeys(components):
        members = [i for i, c in enumerate(components) if c == component]
        members.sort(key=lambda i: tuple(round(v, _POSITION_DIGITS) for v in occurrences[i][1]))
        for ordinal, i in enumerate(members, start=1):
            names[i] = f"{component}#{ordinal}"
    return names
