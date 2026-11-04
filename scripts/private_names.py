"""커밋 전 검사: 실제 상품의 이름이 공개 저장소의 추적 파일로 새지 않게 막는다(docs/recording-guide.md 5장).

    .venv/Scripts/python -m scripts.private_names

비공개 녹화본(fixtures/private/recordings), 탐색 결과(data/probes), 건식 업로드 묶음(data/dry-runs)에서
사용자 파라미터·부품·바디·문서 이름을 모은다(녹화본은 파일 이름이 곧 모델 이름이다). 스테이지된 변경의 더한 줄과
경로에 그 이름이 나오면 실패한다. 단, HEAD의 추적 파일에 이미 나오는 이름은 뺀다. 이미 공개된 이름은 새로 새는
것이 아니고, width·length 같은 흔한 이름은 코드 어딘가에 이미 있어서다. Fusion 기본 바디 이름(본체1, Body1)도 뺀다.
"다리 4개"처럼 이름이 아닌 서술과 메모(.md)의 내용은 잡지 못한다. 그것은 리뷰가 본다(CODING_STANDARDS.md 「공개 저장소」).
"""

import json
import re
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any

PRIVATE_SOURCES = (Path("fixtures/private/recordings"), Path("data/probes"), Path("data/dry-runs"))
# 상품 정보가 아닌 Fusion 기본 이름
_DEFAULT_NAME = re.compile(r"^(본체|Body)\s*\d+$", re.IGNORECASE)


class GitError(Exception):
    pass


def names_in(record: dict[str, Any]) -> set[str]:
    """녹화본(업로드 묶음) 또는 탐색 결과 하나에서 상품을 드러내는 이름"""
    names: set[str] = set()
    for p in record.get("parameters", []):
        if isinstance(p, dict) and p.get("is_user") and p.get("name"):
            names.add(p["name"])
    names |= {part["name"] for part in record.get("parts", []) if isinstance(part, dict) and part.get("name")}
    names |= set(record.get("restored_expressions", {}))
    if record.get("document"):
        names.add(record["document"])
    bodies = record.get("base", {}).get("bodies", [])
    names |= {b["name"] for b in bodies if isinstance(b, dict) and b.get("name")}
    return {n for n in names if _worth_checking(n)}


def _worth_checking(name: str) -> bool:
    # 한글 이름은 두 글자(상판)도 상품을 드러낸다. 영문은 세 글자 아래면 흔한 말과 구별되지 않는다.
    shortest = 2 if not name.isascii() else 3
    return len(name) >= shortest and not _DEFAULT_NAME.match(name)


def pattern(name: str) -> re.Pattern[str]:
    """이름을 찾는 식. 영문·숫자·_ 앞뒤 경계만 본다. 한글 조사가 붙은 꼴(seat_w는, 상판이)도 찾기 위해서다.
    대소문자는 가리지 않는다."""
    return re.compile(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])", re.IGNORECASE)


def leaks(added: Iterable[tuple[str, str]], names: set[str]) -> list[str]:
    """(파일, 더한 줄)마다 이름이 나오는 곳"""
    patterns = {n: pattern(n) for n in names}
    return [f"{path}: {name}" for path, line in added for name, p in patterns.items() if p.search(line)]


def added_lines(diff: str) -> list[tuple[str, str]]:
    """`git diff -U0` 출력에서 (파일, 더한 줄). 새 경로 자체도 한 줄로 넣는다(파일 이름에 든 이름).

    헤더와 본문은 `diff --git`·`@@`로 가른다. 본문의 더한 줄이 "++ "로 시작해 "+++ "처럼 보여도 헤더로 읽지 않는다.
    """
    added: list[tuple[str, str]] = []
    path, in_header = "", False
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            path, in_header = "", True
        elif in_header and line.startswith("+++ "):
            target = line[4:]
            path = target[2:] if target.startswith("b/") else ""
            if path:
                added.append((path, path))
        elif line.startswith("@@"):
            in_header = False
        elif not in_header and path and line.startswith("+"):
            added.append((path, line[1:]))
    return added


def _git(*args: str) -> str:
    done = subprocess.run(
        ["git", "-c", "core.quotePath=false", *args], capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    # git grep은 찾지 못하면 1을 돌려준다
    if done.returncode not in (0, 1):
        raise GitError(f"git {' '.join(args[:2])} 실패({done.returncode}): {done.stderr.strip()}")
    return done.stdout


def _private_names() -> set[str]:
    names: set[str] = set()
    for folder in PRIVATE_SOURCES:
        for path in folder.glob("*.json"):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(record, dict):
                names |= names_in(record)
            if folder.name == "recordings" and _worth_checking(path.stem):
                names.add(path.stem)
    return names


def _public(names: set[str]) -> set[str]:
    """HEAD의 추적 파일에 이미 나오는 이름. 찾는 식은 leaks와 같다."""
    if not names:
        return set()
    args = ["grep", "-I", "-i", "-h", "-F"]
    for n in sorted(names):
        args += ["-e", n]
    lines = _git(*args, "HEAD", "--", ".").splitlines()
    return {n for n in names if any(pattern(n).search(line) for line in lines)}


def main() -> int:
    try:
        names = _private_names()
        names -= _public(names)
        diff = _git("diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/")
    except GitError as error:
        print(f"[pre-commit] 비공개 이름 검사를 하지 못했다: {error}")
        return 1
    found = leaks(added_lines(diff), names)
    if found:
        print("[pre-commit] 비공개 녹화본·탐색 결과의 이름이 추적 파일에 들어간다(공개 저장소). 판정만 적고 이름은 지운다:")
        for f in found:
            print(f"  {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
