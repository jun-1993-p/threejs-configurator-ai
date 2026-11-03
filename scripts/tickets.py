"""로컬 이슈 트래커(.scratch/<기능>/issues/)의 티켓마다 체크 수, "티켓 NN:" 커밋 여부, 막힘을 한 줄씩 찍고 다음 티켓을 고른다.

분류 라벨에 '끝남'이 없어 Status 줄로는 끝난 티켓을 알 수 없다. 체크가 모두 [x]이고 "티켓 NN" 커밋이 있으면 끝난 것으로 본다.
실행: python scripts/tickets.py [기능 슬러그]   (기본: .scratch 아래 issues/가 있는 기능 전부)
"""

import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@dataclass
class Ticket:
    number: int
    title: str
    status: str
    checked: int
    boxes: int
    committed: bool
    blocked_by: list[int]
    # "미룸(티켓 22)": 이 티켓이 다른 티켓으로 미룬 일
    deferred_to: list[int]
    # "(티켓 08에서 옮김)": 다른 티켓이 미뤄 이 티켓이 받은 일
    moved_from: set[int]

    @property
    def done(self) -> bool:
        return self.committed and self.checked == self.boxes


def read_ticket(path: Path, committed: set[int]) -> Ticket:
    text = path.read_text(encoding="utf-8")
    number = int(path.name[:2])
    # 머리 줄 "# 05: 적응형 스윕과 범위 축소"
    title = re.sub(r"^#\s*\d+:\s*", "", text.splitlines()[0]).strip()
    status = re.search(r"Status:\**\s*(\S+)", text)
    blocked = re.search(r"Blocked by:\**\s*(.*)", text)
    return Ticket(
        number=number,
        title=title,
        status=status.group(1) if status else "?",
        checked=len(re.findall(r"^\s*- \[x\]", text, re.M)),
        boxes=len(re.findall(r"^\s*- \[[ x]\]", text, re.M)),
        committed=number in committed,
        # "09 (격자 보강), 11 (위상 묶음)"에서 괄호 밖의 번호만
        blocked_by=[int(n) for n in re.findall(r"(?:^|,)\s*(\d+)", blocked.group(1))] if blocked else [],
        deferred_to=[int(n) for n in re.findall(r"미룸\(티켓 (\d+)\)", text)],
        moved_from={int(n) for n in re.findall(r"티켓 (\d+)에서 옮김", text)},
    )


def lost_deferrals(tickets: list[Ticket]) -> list[tuple[int, int]]:
    """미룬 일 중 받는 티켓에 옮김 표시가 없는 (보낸 티켓, 받는 티켓). 티켓 08이 22로 미룬 일이 22에 없어 사라진 일이 있었다."""
    by_number = {t.number: t for t in tickets}
    return [
        (t.number, to)
        for t in sorted(tickets, key=lambda t: t.number)
        for to in t.deferred_to
        if to not in by_number or t.number not in by_number[to].moved_from
    ]


def committed_numbers(subjects: list[str]) -> set[int]:
    """커밋 제목 "티켓 03: …", "티켓 03 리뷰 반영: …"의 티켓 번호"""
    return {int(m.group(1)) for s in subjects if (m := re.match(r"티켓 (\d+)\b", s))}


def next_ticket(tickets: list[Ticket]) -> Ticket | None:
    """끝나지 않았고, 막는 티켓이 모두 끝났고, 에이전트가 할 수 있는 티켓 중 번호가 앞선 것"""
    done = {t.number for t in tickets if t.done}
    for t in sorted(tickets, key=lambda t: t.number):
        if not t.done and t.status == "ready-for-agent" and all(b in done for b in t.blocked_by):
            return t
    return None


def report(tickets: list[Ticket]) -> str:
    done = {t.number for t in tickets if t.done}
    lines = []
    for t in sorted(tickets, key=lambda t: t.number):
        waiting = [b for b in t.blocked_by if b not in done]
        state = "끝남" if t.done else f"막힘({', '.join(f'{b:02d}' for b in waiting)})" if waiting else "열림"
        commit = "커밋 있음" if t.committed else "커밋 없음"
        lines.append(f"{t.number:02d} {state:<10} 체크 {t.checked}/{t.boxes}  {commit}  {t.status:<16} {t.title}")
    for sender, to in lost_deferrals(tickets):
        lines.append(f"미룬 일 빠짐: {sender:02d} → {to:02d}, 받는 티켓에 '(티켓 {sender:02d}에서 옮김)' 항목이 없다")
    nxt = next_ticket(tickets)
    lines.append(f"다음: {nxt.number:02d} {nxt.title}" if nxt else "다음: 에이전트가 할 티켓 없음")
    return "\n".join(lines)


def main(argv: list[str]) -> None:
    subjects = subprocess.run(
        ["git", "log", "--format=%s"], cwd=ROOT, capture_output=True, encoding="utf-8", check=True
    ).stdout.splitlines()
    committed = committed_numbers(subjects)
    features = [ROOT / ".scratch" / argv[0]] if argv else sorted(p.parent for p in (ROOT / ".scratch").glob("*/issues"))
    for feature in features:
        print(f"# {feature.name}")
        print(report([read_ticket(p, committed) for p in sorted((feature / "issues").glob("[0-9][0-9]-*.md"))]))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    main(sys.argv[1:])
