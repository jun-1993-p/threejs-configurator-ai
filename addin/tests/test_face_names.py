from uploader.face_names import EdgeRole, FaceRole, edge_faces, edge_names, face_names


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
