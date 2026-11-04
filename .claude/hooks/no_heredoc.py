"""PreToolUse(Bash) 훅: heredoc(<<)이 든 명령과, 셸로 파이썬 파일을 쓰는 명령을 막는다.

Windows Git Bash에서 heredoc으로 편집 스크립트를 넘기면 한국어·줄끝이 깨지기 쉽다. printf·echo·tee나
`python -c`로 .py 파일을 쓰는 것도 같은 우회다(티켓 26 회고: heredoc을 막자 printf로 두 번 비켜 갔다).
막으면서 에이전트에게 대신 할 일을 알린다(종료 코드 2의 stderr가 에이전트에게 간다).
파일 이름(no_heredoc)은 .claude/settings.json의 훅 경로에 걸려 있어 그대로 둔다.
"""

import json
import re
import sys

# <<< (here-string)는 두고 <<, <<-, <<'EOF' 같은 heredoc만 잡는다
HEREDOC = re.compile(r"(?<!<)<<-?\s*['\"]?\w")
# .py로 끝나는 경로: 큰따옴표·작은따옴표 안(공백 허용) 또는 따옴표 없는 한 낱말. .py.bak 같은 것은 아니다.
_PY_PATH = r"""(?:"[^"]*\.py"|'[^']*\.py'|[^\s'"|;&<>()]+\.py)(?=$|[\s|;&)])"""
# 쓰기 대상이 .py인 것: 리디렉션(>, >>, 2> 등), tee, 인라인 파이썬의 open(…'w')·write_text/write_bytes.
# 무엇이 출력을 내는지는 보지 않는다. 따옴표 안의 ;·|가 명령을 가르는 것처럼 보여도 빠져나가지 않게 하려는 것이다.
PY_WRITE = re.compile(
    rf">>?\s*{_PY_PATH}"
    rf"|\btee\b(?:\s+-\w+)*\s+{_PY_PATH}"
    r"""|open\([^)]*\.py['"][^)]*['"][wax]"""
    r"""|\.py['"]\)\.write_(?:text|bytes)\("""
)
GUIDE = (
    "편집·스크립트는 Write 도구로 scratchpad에 .py 파일을 만들고 `.venv/Scripts/python 파일경로`로 실행한다. "
    "커밋 메시지는 Write로 만든 파일을 `git commit -F`로 넘긴다."
)


def blocked(command: str) -> str | None:
    """막을 까닭. 막지 않으면 None."""
    if HEREDOC.search(command):
        return "heredoc은 쓰지 않는다. " + GUIDE
    if PY_WRITE.search(command):
        return "셸(printf·echo·tee·python -c)로 파이썬 파일을 쓰지 않는다. " + GUIDE
    return None


def main() -> None:
    # Windows 기본 코드 페이지(cp949)로 내보내면 한국어가 깨진다
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    reason = blocked(json.load(sys.stdin).get("tool_input", {}).get("command", ""))
    if reason:
        print(reason, file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
