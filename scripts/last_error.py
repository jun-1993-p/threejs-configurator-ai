"""애드인·탐색 스크립트가 남긴 실패 기록(last-error.txt)을 위저드가 읽는다. 사람이 창의 문장을 옮겨 적지 않게 한다.

    .venv/Scripts/python -m scripts.last_error <기록 파일> <기준 파일> <제목>

기록의 첫 줄은 "<날짜> <시각> <제목>"이다(애드인 _report, 탐색 스크립트). 기준 파일보다 뒤에 쓴 기록이고 제목이
같을 때만 "첫 줄 / 마지막 줄"을 찍는다. 제목을 보는 것은, 업로드를 기다리는 동안 애드인을 다시 실행하다 난
"애드인 종료 실패"나 앞서 실패한 "업로드 점검 실패"를 업로드 실패로 읽지 않기 위해서다.
"""

import sys
from pathlib import Path


def failure(record: Path, since: Path, title: str) -> str | None:
    if not record.is_file() or not since.is_file() or record.stat().st_mtime <= since.stat().st_mtime:
        return None
    lines = record.read_text(encoding="utf-8", errors="replace").splitlines()
    if not lines or lines[0].split(" ", 2)[-1] != title:
        return None
    return f"{lines[0]} / {lines[-1]}"


def main(args: list[str]) -> None:
    found = failure(Path(args[0]), Path(args[1]), args[2])
    if found:
        print(found)


if __name__ == "__main__":
    main(sys.argv[1:])
