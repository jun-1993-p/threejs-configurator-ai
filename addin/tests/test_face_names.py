from uploader.face_names import BodyTag, EdgeRole, FaceRole, body_name, body_names, edge_faces, edge_names, face_names


def test_기본_형상에서는_피처와_역할로_짓고_같은_이름은_순번을_붙인다() -> None:
    faces = [
        FaceRole("돌출1", "start", (0.0,)),
        FaceRole("돌출1", "side", (2.0,)),
        FaceRole("돌출1", "side", (1.0,)),
        FaceRole("", "face", (0.0,)),
    ]

    assert face_names(faces, baseline=True) == ["돌출1:start", "돌출1:side:2", "돌출1:side:1", "face"]


def test_기본_형상에서_붙인_표시는_순서가_바뀌어도_그대로_쓴다() -> None:
    faces = [FaceRole("돌출1", "side", (9.0,), tag="돌출1:side:1"), FaceRole("돌출1", "side", (0.0,), tag="돌출1:side:2")]

    assert face_names(faces, baseline=False) == ["돌출1:side:1", "돌출1:side:2"]


def test_표시가_겹치거나_없는_면은_기본_형상에_없는_이름을_받는다() -> None:
    faces = [
        FaceRole("돌출1", "side", (2.0,), tag="돌출1:side:1"),
        FaceRole("돌출1", "side", (1.0,), tag="돌출1:side:1"),
        FaceRole("돌출1", "start", (0.0,)),
        FaceRole("돌출1", "start", (0.0,), tag="돌출1:start"),
    ]

    assert face_names(faces, baseline=False) == [
        "돌출1:side:1:split2",
        "돌출1:side:1:split1",
        "돌출1:start:new1",
        "돌출1:start",
    ]


def test_피처_이름의_세로선과_물결은_면_이름에_남지_않는다() -> None:
    names = face_names([FaceRole("a|b~c", "start", ())], baseline=True)

    assert names == ["a_b_c:start"]


def test_모서리는_두_면_이름_쌍이고_같은_쌍이_여럿이면_순번을_붙인다() -> None:
    edges = [
        EdgeRole("돌출1:start", "돌출1:side:1", (5.0,)),
        EdgeRole("돌출1:side:2", "돌출1:start", (1.0,)),
        EdgeRole("돌출1:side:2", "돌출1:start", (0.0,)),
    ]
    names = edge_names(edges)

    assert names == ["돌출1:side:1|돌출1:start", "돌출1:side:2|돌출1:start~2", "돌출1:side:2|돌출1:start~1"]
    faces = {"돌출1:start", "돌출1:side:1", "돌출1:side:2"}
    assert edge_faces(names[1], faces) == ("돌출1:side:2", "돌출1:start")


def test_바디_이름은_면에_붙인_기본_형상의_바디_이름에서_읽는다() -> None:
    """Fusion은 재계산 뒤 바디를 새로 만들어 이름(본체4 → 본체5)과 바디 속성을 잃지만 면 표시는 남는다(티켓 26 4절)."""
    assert body_name(["본체4", "본체4", None]) == "본체4"
    assert body_name([None, None]) is None
    assert body_name([]) is None


def test_면마다_바디_이름이_다르면_가장_많은_것_같으면_이름_순으로_앞의_것을_쓴다() -> None:
    assert body_name(["B", "A", "B"]) == "B"
    assert body_name(["B", "A"]) == "A"


def test_한_부품_안의_바디_이름은_표시를_쓰고_표시가_없으면_Fusion_이름이다() -> None:
    names, fallback = body_names([BodyTag("본체3", 4, "본체5"), BodyTag(None, 0, "본체9")])

    assert names == ["본체3", "본체9"]
    assert fallback == ["본체9"]


def test_바디가_갈라져_표시가_겹치면_표시된_면이_가장_많은_바디만_그_이름을_쓴다() -> None:
    """잘라내기로 바디 하나가 둘이 되면 두 조각의 면이 같은 바디 표시를 물려받는다. 같은 이름이면 면 샘플이 섞인다."""
    names, fallback = body_names([BodyTag("본체1", 2, "본체6"), BodyTag("본체1", 5, "본체1")])

    assert names == ["본체6", "본체1"]
    assert fallback == ["본체6"]


def test_Fusion_이름으로_돌린_바디가_다른_바디의_표시와_겹치면_꼬리를_붙인다() -> None:
    names, fallback = body_names([BodyTag(None, 0, "본체2"), BodyTag("본체2", 3, "본체7")])

    assert names == ["본체2:new", "본체2"]
    assert fallback == ["본체2"]
