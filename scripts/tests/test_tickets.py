"""티켓 목록 도구가 체크와 커밋으로 끝난 티켓을 가리고, 막히지 않은 다음 티켓을 고르는지 본다."""

from pathlib import Path

from scripts.tickets import committed_numbers, lost_deferrals, next_ticket, read_ticket


def write_ticket(
    issues: Path, name: str, status: str, blocked_by: str, boxes: list[bool], comments: str = ""
) -> Path:
    path = issues / name
    checks = "\n".join(f"- [{'x' if b else ' '}] 항목" for b in boxes)
    path.write_bytes(
        f"# {name[:2]}: 제목\n\n**Blocked by:** {blocked_by}\n\n**Status:** {status}\n\n{checks}\n\n{comments}".encode(
            "utf-8"
        )
    )
    return path


def test_커밋_제목에서_티켓_번호를_읽는다() -> None:
    assert committed_numbers(["티켓 03: 실행기", "티켓 03 리뷰 반영: 정리", "티켓 25: 격자", "회고 반영"]) == {3, 25}


def test_체크가_모두_끝나고_커밋이_있어야_끝난_티켓이다(tmp_path: Path) -> None:
    path = write_ticket(tmp_path, "01-a.md", "ready-for-agent", "None (can start immediately)", [True, True])
    assert read_ticket(path, {1}).done
    assert not read_ticket(path, set()).done
    half = write_ticket(tmp_path, "02-b.md", "ready-for-agent", "None", [True, False])
    assert not read_ticket(half, {2}).done


def test_건너뛴_앞번호_티켓을_다음_티켓으로_고른다(tmp_path: Path) -> None:
    # 04 다음에 06이 끝나 05가 빠진 채 남은 경우
    tickets = [
        read_ticket(write_ticket(tmp_path, "04-a.md", "ready-for-agent", "None", [True]), {4, 6}),
        read_ticket(write_ticket(tmp_path, "05-b.md", "ready-for-agent", "04 (앞 티켓)", [False]), {4, 6}),
        read_ticket(write_ticket(tmp_path, "06-c.md", "ready-for-agent", "04 (앞 티켓)", [True]), {4, 6}),
    ]
    nxt = next_ticket(tickets)
    assert nxt is not None and nxt.number == 5


def test_막는_티켓이_안_끝났거나_사람이_할_티켓은_고르지_않는다(tmp_path: Path) -> None:
    tickets = [
        read_ticket(write_ticket(tmp_path, "01-a.md", "ready-for-human", "None", [False]), set()),
        read_ticket(write_ticket(tmp_path, "02-b.md", "ready-for-agent", "01 (사람 확인), 03 (다른 것)", [False]), set()),
    ]
    assert tickets[1].blocked_by == [1, 3]
    assert next_ticket(tickets) is None


def test_미룬_일을_받는_티켓에_옮김_표시가_없으면_빠진_일로_찍는다(tmp_path: Path) -> None:
    sender = write_ticket(tmp_path, "08-a.md", "ready-for-agent", "None", [True], "- HTTP 포트는 미룸(티켓 22). 화면은 미룸(티켓 23).\n")
    # 22는 그 일을 받지 않고 끝났고, 23은 체크 항목으로 옮겨 받았다
    late = write_ticket(tmp_path, "22-b.md", "ready-for-agent", "None", [True])
    moved = write_ticket(tmp_path, "23-c.md", "ready-for-agent", "None", [False], "- [ ] 화면 띄우기 (티켓 08에서 옮김)\n")
    tickets = [read_ticket(p, {8, 22}) for p in (sender, late, moved)]
    assert tickets[0].deferred_to == [22, 23]
    assert lost_deferrals(tickets) == [(8, 22)]
