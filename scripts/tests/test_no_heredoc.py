"""Bash 훅(.claude/hooks/no_heredoc.py)이 heredoc과 셸로 파이썬 파일 쓰기를 막고, 그 밖은 두는지 본다."""

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

HOOK = Path(__file__).resolve().parents[2] / ".claude" / "hooks" / "no_heredoc.py"


def _hook() -> ModuleType:
    spec = importlib.util.spec_from_file_location("no_heredoc", HOOK)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    "command",
    [
        "cat <<'EOF' > a.py\nprint(1)\nEOF",
        "python - <<EOF\nprint(1)\nEOF",
        "printf '%s\\n' 'print(1)' > \"$S/fix.py\"",
        "echo 'import sys' >> scripts/x.py",
        # 따옴표 안의 ;·&&·|가 명령을 가르는 것처럼 보여도 빠져나가지 않는다
        "printf 'import os; os.remove(1)' > x.py",
        "printf 'a && b | c' > x.py",
        "echo x > \"my dir/x.py\"",
        "printf 'x' | tee -a scripts/x.py",
        "printf 'x' | sed 's/a/b/' > x.py",
        "python -c \"open('x.py', 'w').write('1')\"",
        "python -c \"from pathlib import Path; Path('x.py').write_text('1')\"",
    ],
)
def test_heredoc과_셸로_파이썬_파일_쓰기는_막는다(command: str) -> None:
    assert _hook().blocked(command) is not None


@pytest.mark.parametrize(
    "command",
    [
        "grep -q x <<< \"$lines\"",
        "printf '%s\\n' '- seat_w' > leak-probe.md",
        "printf '{\"name\": \"%s\"}' \"$n\" > \"$body\"",
        "printf 'a\\nb\\n' | .venv/Scripts/python scripts/x.py",
        ".venv/Scripts/python scripts/x.py > out.txt",
        "echo done && .venv/Scripts/python fix.py",
        "cp x.py x.py.bak > log.txt",
        "python -c \"print(open('x.py').read())\"",
        "git add scripts/x.py && git commit -F msg.txt",
    ],
)
def test_그_밖의_명령은_둔다(command: str) -> None:
    assert _hook().blocked(command) is None
