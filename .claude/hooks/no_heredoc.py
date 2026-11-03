"""PreToolUse(Bash) 훅: heredoc(<<)이 든 명령을 막는다.

Windows Git Bash에서 heredoc으로 편집 스크립트를 넘기면 한국어·줄끝이 깨지기 쉽다.
막으면서 에이전트에게 대신 할 일을 알린다(종료 코드 2의 stderr가 에이전트에게 간다).
"""

import json
import re
import sys

# Windows 기본 코드 페이지(cp949)로 내보내면 한국어가 깨진다
sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
command = json.load(sys.stdin).get("tool_input", {}).get("command", "")
# <<< (here-string)는 두고 <<, <<-, <<'EOF' 같은 heredoc만 잡는다
if re.search(r"(?<!<)<<-?\s*['\"]?\w", command):
    print(
        "heredoc은 쓰지 않는다. 편집·스크립트는 Write 도구로 scratchpad에 .py 파일을 만들고 "
        "`.venv/Scripts/python 파일경로`로 실행한다. 커밋 메시지는 Write로 만든 파일을 `git commit -F`로 넘긴다.",
        file=sys.stderr,
    )
    sys.exit(2)
