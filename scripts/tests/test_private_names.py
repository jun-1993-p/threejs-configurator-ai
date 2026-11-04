"""비공개 이름 검사가 녹화본·탐색 결과에서 이름을 모으고, 스테이지된 diff의 더한 줄과 경로에서 찾는지 본다."""

from scripts.private_names import added_lines, leaks, names_in


def test_녹화본과_탐색_결과에서_상품을_드러내는_이름을_모으고_기본_이름은_뺀다() -> None:
    recording = {
        "parameters": [
            {"name": "seat_w", "is_user": True},
            {"name": "d12", "is_user": False},
        ],
        "parts": [{"name": "Leg_front"}, {"name": "본체3"}, {"name": "Body 12"}],
    }
    probe = {"document": "stool_pro", "base": {"bodies": [{"name": "상판"}]}, "restored_expressions": {"seat_h": "1"}}

    assert names_in(recording) == {"seat_w", "Leg_front"}
    assert names_in(probe) == {"stool_pro", "상판", "seat_h"}


def test_조사가_붙은_이름과_대소문자가_다른_이름도_찾고_더_긴_영문_이름은_가른다() -> None:
    added = [
        ("ticket.md", "- seat_w는 모두 same이다"),
        ("ticket.md", "- SEAT_W 스윕"),
        ("ticket.md", "- 상판이 앞으로 나온다"),
        ("ticket.md", "- seat_width는 다른 이름이다"),
        ("code.py", "x = my_seat_w"),
    ]

    assert leaks(added, {"seat_w", "상판"}) == ["ticket.md: seat_w", "ticket.md: seat_w", "ticket.md: 상판"]


def test_diff에서_더한_줄과_새_경로를_읽고_더한_줄이_헤더처럼_보여도_헤더로_읽지_않는다() -> None:
    diff = "\n".join(
        [
            "diff --git a/notes.md b/notes.md",
            "index 1..2 100644",
            "--- a/notes.md",
            "+++ b/notes.md",
            "@@ -0,0 +1,2 @@",
            "+++ seat_w 줄",
            "+둘째 줄",
            "diff --git a/old.md b/한글 경로/seat_h.md",
            "similarity index 90%",
            "rename from old.md",
            "rename to 한글 경로/seat_h.md",
            "--- a/old.md",
            "+++ b/한글 경로/seat_h.md",
            "diff --git a/gone.md b/gone.md",
            "deleted file mode 100644",
            "--- a/gone.md",
            "+++ /dev/null",
            "@@ -1 +0,0 @@",
            "-지운 줄",
        ]
    )

    assert added_lines(diff) == [
        ("notes.md", "notes.md"),
        ("notes.md", "++ seat_w 줄"),
        ("notes.md", "둘째 줄"),
        ("한글 경로/seat_h.md", "한글 경로/seat_h.md"),
    ]
