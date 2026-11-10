#!/usr/bin/env python3
"""
render.py: explain-diff-html-ko 스킬의 렌더러.

JSON 콘텐츠 명세를 받아 단일 HTML 페이지로 만든다. CSS, 퀴즈 JS, 문서 골격,
목차, 선택지 무작위화, 한국어 UI 문구는 렌더러가 맡고, 에이전트는 내용만 쓴다.
렌더 뒤에는 한국어 점검(lint)을 돌려 경고를 stderr로 낸다.

사용:
    python render.py spec.json -o output.html [--strict]

--strict: 점검 경고가 하나라도 있으면 종료 코드 1을 돌려준다(파일은 쓴다).

명세(JSON):
{
  "title": "티켓 12: 두께 선택",
  "lead": "한두 문장으로 이 변경이 무엇을 하는지.",
  "provenance": "owner/repo 티켓 12, 기준 커밋 6c05d18, 2026-11-04 작성. 참조는 이 커밋을 가리킨다.",
  "slug": "ticket-12",
  "language": "ko",
  "sections": [
    {"id": "background", "heading": "배경", "html": "<p>...</p>"},
    {"id": "intuition",  "heading": "핵심 아이디어", "html": "..."},
    {"id": "code",       "heading": "코드 따라가기", "html": "..."}
  ],
  "quiz": [
    {"question": "...",
     "options": [{"text": "...", "correct": true, "feedback": "..."}, ...]}
  ]
}

"html" 필드는 마크다운이 아니라 HTML이다. 코드 블록은
<pre><code class="language-{언어}">...</code></pre> 형식이고 코드 안의
<, >, &는 이스케이프한다. 소스 참조는
<a class="srcref" href="..."><code>path:line</code></a> 로 감싼다.
링크하지 않는 참조는 <code data-bare="outside-repo">path:line</code> 로 표시한다.
퀴즈 문항과 선택지에는 <code>…</code>만 허용한다.
"""
import argparse
import datetime
import html
import json
import random
import re
import sys
from pathlib import Path

HIGHLIGHT_VERSION = "11.11.1"
HIGHLIGHT_JS_URL = f"https://cdnjs.cloudflare.com/ajax/libs/highlight.js/{HIGHLIGHT_VERSION}/highlight.min.js"
HIGHLIGHT_CSS_URL = f"https://cdnjs.cloudflare.com/ajax/libs/highlight.js/{HIGHLIGHT_VERSION}/styles/github-dark.min.css"

CSS = """
  :root {
    --bg: #fafaf8; --fg: #1a1a1a; --accent: #b5541f; --muted: #6b6b6b;
    --code-bg: #0d1117; --code-fg: #c9d1d9; --callout-bg: #fff4e8; --border: #e0ddd6;
    --panel: #fff; --inline-code: #eee; --th: #f0ede6; --box-bg: #fdf6ee; --hover: #f5f2ec;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16171a; --fg: #e8e6e1; --accent: #e8905a; --muted: #9a9890;
      --callout-bg: #2a2118; --border: #3a3935; --panel: #1f2023;
      --inline-code: #2c2d31; --th: #26272b; --box-bg: #261f18; --hover: #2a2b30;
    }
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif;
    background: var(--bg); color: var(--fg);
    max-width: 820px; margin: 0 auto; padding: 2rem 1.5rem 6rem; line-height: 1.75; word-break: keep-all; }
  h1 { font-size: 1.9rem; border-bottom: 3px solid var(--accent); padding-bottom: .5rem; }
  h2 { font-size: 1.4rem; margin-top: 3rem; color: var(--accent); }
  h3 { font-size: 1.1rem; margin-top: 1.8rem; }
  .lead { font-size: 1.05rem; }
  .provenance { color: var(--muted); font-size: .88rem; margin-top: -.4rem; }
  code { font-family: 'SF Mono', Consolas, monospace; background: var(--inline-code); padding: .1rem .3rem; border-radius: 3px; font-size: .92em; word-break: break-all; }
  pre { background: var(--code-bg); color: var(--code-fg); padding: 1rem 1.2rem; border-radius: 8px;
    overflow-x: auto; white-space: pre-wrap; font-family: 'SF Mono', Consolas, monospace; font-size: .88rem; line-height: 1.5; word-break: normal; }
  pre code { background: none; padding: 0; color: inherit; word-break: normal; }
  pre code.hljs { padding: 0; background: transparent; }
  a.srcref { text-decoration: none; }
  a.srcref code { color: var(--accent); }
  a.srcref:hover code { text-decoration: underline; }
  .filename { font-family: 'SF Mono', Consolas, monospace; font-size: .8rem; color: var(--muted);
    margin: 1.2rem 0 -.6rem; }
  .callout { background: var(--callout-bg); border-left: 4px solid var(--accent); padding: .9rem 1.2rem;
    border-radius: 0 6px 6px 0; margin: 1.2rem 0; }
  details { border: 1px solid var(--border); border-radius: 8px; padding: .6rem 1.1rem; margin: 1rem 0; background: var(--panel); }
  details > summary { cursor: pointer; font-weight: 600; }
  .toc { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.5rem; margin: 1.5rem 0; }
  .toc a { color: var(--accent); text-decoration: none; }
  .toc ul { margin: .3rem 0; }
  .diagram { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 1.2rem;
    margin: 1.2rem 0; font-size: .9rem; }
  .flow { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; justify-content: center; padding: .5rem 0; }
  .box { border: 2px solid var(--accent); border-radius: 8px; padding: .6rem 1rem; background: var(--box-bg); text-align: center; min-width: 120px; }
  .box.fail { border-color: #b91c1c; background: #fef2f2; color: #7f1d1d; }
  .arrow { font-size: 1.4rem; color: var(--muted); }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .92rem; }
  th, td { border: 1px solid var(--border); padding: .5rem .7rem; text-align: left; }
  th { background: var(--th); }
  .quiz-q { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 1.2rem 1.5rem; margin: 1.2rem 0; }
  .quiz-opt { display: block; width: 100%; text-align: left; padding: .6rem 1rem; margin: .4rem 0;
    border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--fg);
    cursor: pointer; font-family: inherit; font-size: .95rem; line-height: 1.6; }
  .quiz-opt:hover { background: var(--hover); }
  .quiz-opt:focus-visible, .toc a:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
  .feedback { display: none; margin-top: .6rem; padding: .6rem 1rem; border-radius: 6px; font-size: .9rem; }
  .feedback.correct { background: #ecfdf3; color: #166534; border-left: 3px solid #16a34a; }
  .feedback.incorrect { background: #fef2f2; color: #991b1b; border-left: 3px solid #dc2626; }
  .badge { display: inline-block; font-size: .75rem; padding: .15rem .5rem; border-radius: 10px; font-family: sans-serif; }
  .badge.new { background: #dcfce7; color: #166534; }
  @media (max-width: 600px) { body { padding: 1rem; } .flow { flex-direction: column; } }
"""

QUIZ_JS = """
document.querySelectorAll('.quiz-q').forEach(q => {
  q.querySelectorAll('.quiz-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      const correct = opt.dataset.correct === 'true';
      q.querySelectorAll('.feedback').forEach(item => item.style.display = 'none');
      q.querySelectorAll('.quiz-opt').forEach(item => item.setAttribute('aria-expanded', 'false'));
      const fb = opt.nextElementSibling;
      fb.className = 'feedback ' + (correct ? 'correct' : 'incorrect');
      fb.style.display = 'block';
      opt.setAttribute('aria-expanded', 'true');
    });
  });
});
"""

UI_TEXT = {
    "en": {"contents": "Contents", "quiz": "Quiz", "correct": "Correct.", "incorrect": "Not quite."},
    "ko": {"contents": "목차", "quiz": "퀴즈", "correct": "정답이다.", "incorrect": "오답이다."},
}

PRE_TAG_RE = re.compile(r"<pre\b", re.IGNORECASE)
HIGHLIGHTABLE_PRE_RE = re.compile(
    r'''<pre\b[^>]*>\s*<code\b[^>]*class=["'][^"']*\blanguage-[A-Za-z0-9_+.-]+[^"']*["'][^>]*>''',
    re.IGNORECASE,
)


def slugify(text: str) -> str:
    slug = re.sub(r"[^\w]+", "-", text.lower(), flags=re.UNICODE).strip("-")
    return slug or "code-change"


def _visible_text_length(text: str) -> int:
    without_tags = re.sub(r"<[^>]*>", "", str(text))
    return len(" ".join(html.unescape(without_tags).split()))


def inline_html(text: str) -> str:
    """퀴즈 문항·선택지용: 전부 이스케이프하되 <code>…</code>만 살린다."""
    escaped = html.escape(str(text))
    return re.sub(r"&lt;code&gt;(.*?)&lt;/code&gt;", r"<code>\1</code>", escaped)


def validate_quiz(quiz: list) -> None:
    """형식이 틀린 퀴즈와, 선택지 길이로 정답이 드러나는 퀴즈를 거절한다."""
    longest_correct = []
    shortest_correct = []
    conspicuous_outliers = []

    for question_number, question in enumerate(quiz, start=1):
        if not isinstance(question, dict):
            raise ValueError(f"퀴즈 {question_number}번이 객체가 아니다")
        if not isinstance(question.get("question"), str) or not question["question"].strip():
            raise ValueError(f"퀴즈 {question_number}번에 질문 문장이 없다")

        options = question.get("options", [])
        if not isinstance(options, list) or not 3 <= len(options) <= 4:
            raise ValueError(f"퀴즈 {question_number}번의 선택지는 3~4개여야 한다")

        for option_number, option in enumerate(options, start=1):
            if not isinstance(option, dict):
                raise ValueError(f"퀴즈 {question_number}번 선택지 {option_number}가 객체가 아니다")
            if not isinstance(option.get("correct"), bool):
                raise ValueError(f"퀴즈 {question_number}번 선택지 {option_number}에 불리언 'correct'가 없다")
            if not isinstance(option.get("feedback"), str) or not option["feedback"].strip():
                raise ValueError(f"퀴즈 {question_number}번 선택지 {option_number}에 구체적인 feedback이 없다")

        correct_indexes = [i for i, option in enumerate(options) if option.get("correct") is True]
        if len(correct_indexes) != 1:
            raise ValueError(f"퀴즈 {question_number}번은 정답이 정확히 하나여야 한다")

        lengths = [_visible_text_length(option.get("text", "")) for option in options]
        if any(length == 0 for length in lengths):
            raise ValueError(f"퀴즈 {question_number}번에 빈 선택지가 있다")
        normalized = [" ".join(str(option["text"]).split()).casefold() for option in options]
        if len(set(normalized)) != len(normalized):
            raise ValueError(f"퀴즈 {question_number}번에 같은 선택지가 있다")

        correct_length = lengths[correct_indexes[0]]
        incorrect_lengths = [length for i, length in enumerate(lengths) if i != correct_indexes[0]]
        if correct_length - max(incorrect_lengths) >= 5:
            longest_correct.append(question_number)
        if min(incorrect_lengths) - correct_length >= 5:
            shortest_correct.append(question_number)

        shortest = min(lengths)
        longest = max(lengths)
        if longest - shortest >= 20 and longest > shortest * 1.5:
            conspicuous_outliers.append(question_number)

    problems = []
    if conspicuous_outliers:
        problems.append("선택지 길이가 눈에 띄게 다른 문항: " + ", ".join(map(str, conspicuous_outliers)))
    if len(quiz) >= 3 and len(longest_correct) > len(quiz) / 2:
        problems.append("정답이 가장 긴 문항이 절반을 넘는다: " + ", ".join(map(str, longest_correct)))
    if len(quiz) >= 3 and len(shortest_correct) > len(quiz) / 2:
        problems.append("정답이 가장 짧은 문항이 절반을 넘는다: " + ", ".join(map(str, shortest_correct)))
    if problems:
        raise ValueError("선택지 길이가 정답 단서가 된다. 길이가 단서가 되지 않게 다시 써라. " + "; ".join(problems))


def validate_spec(spec: dict) -> None:
    if not isinstance(spec, dict):
        raise ValueError("콘텐츠 명세는 JSON 객체여야 한다")
    if not isinstance(spec.get("title"), str) or not spec["title"].strip():
        raise ValueError("'title'이 비어 있다")
    for key in ("lead", "provenance", "subtitle"):
        if key in spec and not isinstance(spec[key], str):
            raise ValueError(f"'{key}'는 문자열이어야 한다")
    if "slug" in spec and (not isinstance(spec["slug"], str) or not spec["slug"].strip()):
        raise ValueError("'slug'를 주면 비어 있지 않은 문자열이어야 한다")

    language = spec.get("language", "ko")
    if not isinstance(language, str) or not re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*", language):
        raise ValueError("'language'는 'ko', 'en', 'ko-KR' 같은 언어 코드여야 한다")

    sections = spec.get("sections", [])
    if not isinstance(sections, list) or not sections:
        raise ValueError("섹션이 하나 이상 있어야 한다")
    section_ids = []
    for section_number, section in enumerate(sections, start=1):
        if not isinstance(section, dict):
            raise ValueError(f"섹션 {section_number}이 객체가 아니다")
        section_id = section.get("id")
        if not isinstance(section_id, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", section_id):
            raise ValueError(f"섹션 {section_number}의 id는 영문자로 시작하고 영문·숫자·'_'·'-'만 쓴다")
        for field in ("heading", "html"):
            if not isinstance(section.get(field), str) or not section[field].strip():
                raise ValueError(f"섹션 {section_number}의 '{field}'가 비어 있다")
        pre_count = len(PRE_TAG_RE.findall(section["html"]))
        highlighted = len(HIGHLIGHTABLE_PRE_RE.findall(section["html"]))
        if pre_count != highlighted:
            raise ValueError(
                f"섹션 {section_number}의 코드 블록은 "
                '<pre><code class="language-{언어}">...</code></pre> 형식이어야 한다'
            )
        section_ids.append(section_id)
    if len(set(section_ids)) != len(section_ids):
        raise ValueError("섹션 id가 겹친다")

    quiz = spec.get("quiz", [])
    if not isinstance(quiz, list):
        raise ValueError("'quiz'는 목록이어야 한다")
    validate_quiz(quiz)


# ---------------------------------------------------------------------------
# 한국어 점검(lint). 경고만 내고 렌더는 막지 않는다.
# ---------------------------------------------------------------------------

ENGLISH_LEFTOVERS = [
    "References link", "References are not linked", "explained ", "Background",
    "Intuition", "Code walkthrough",
]
POLITE_ENDINGS = re.compile(r"(합니다|입니다|습니다|해요|예요|이에요|하세요|해 주세요|해주세요)[.\s]")
# 영어 동사를 직역한 낱말: (정규식, 권고)
CALQUE_VERBS = [
    (r"위에 선다|위에 서", "위에 선다", "'바탕으로 한다'"),
    (r"(를|을) 부른다|(를|을) 불러|부르는 (함수|쪽)", "부른다", "함수 호출이면 '호출한다'"),
    (r"(을|를) 돌린다|돌려 본다|돌아간다", "돌린다", "'실행한다'"),
    (r"닿는|닿아", "닿는다", "'미치는/걸치는'"),
    (r"일러 준다", "일러 준다", "'알려 준다'"),
    (r"꽂는다|꽂아", "꽂는다", "'연결한다'"),
    (r"붙든다", "붙든다", "'보관한다'"),
]
LONG_SENTENCE = 100
MAX_PARENS = 2
FILELINE_RE = re.compile(r"[\w./\\-]+\.[A-Za-z0-9]{1,6}:\d+(?:[-~]\d+)?")


def _prose_text(fragment: str) -> str:
    """코드 블록을 빼고 태그를 걷어 낸 본문."""
    t = re.sub(r"<pre\b.*?</pre>", " ", fragment, flags=re.S | re.I)
    t = re.sub(r"<code\b[^>]*>(.*?)</code>", lambda m: "`" + m.group(1) + "`", t, flags=re.S | re.I)
    t = re.sub(r"</(p|li|h\d|div|tr|summary)>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", "", t)
    return html.unescape(t)


def _sentences(text: str) -> list:
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        # 코드 스팬 안의 마침표에서 끊지 않도록 스팬을 잠시 가린다
        masked = re.sub(r"`[^`]*`", lambda m: m.group(0).replace(".", "\u0001"), line)
        for s in re.split(r"(?<=[다요음임함])\.\s+|(?<=[?!])\s+", masked):
            s = s.replace("\u0001", ".").strip()
            if len(s) > 5:
                out.append(s)
    return out


def lint(spec: dict) -> list:
    warnings = []
    if not spec.get("provenance", "").strip():
        warnings.append("provenance(출처 줄)가 없다: 저장소, 기준 커밋, 작성일, 참조 링크 여부를 적어라")

    # (이름, html) 목록: 섹션과 퀴즈를 같은 방식으로 본다
    parts = [(s["heading"], s["html"]) for s in spec.get("sections", [])]
    quiz = spec.get("quiz", [])
    quiz_html = " ".join(
        "<p>" + q["question"] + "</p>" + "".join(
            "<p>" + o["text"] + "</p><p>" + o["feedback"] + "</p>" for o in q["options"]
        )
        for q in quiz
    )
    if quiz_html:
        parts.append(("퀴즈", quiz_html))
    lead = spec.get("lead", "")
    if lead:
        parts.append(("lead", "<p>" + lead + "</p>"))

    if quiz and len(quiz) != 5:
        warnings.append(f"퀴즈가 {len(quiz)}문항이다: 다섯 문항을 만든다")

    all_prose = ""
    bare = 0
    for name, frag in parts:
        prose = _prose_text(frag)
        all_prose += "\n" + prose

        # 소스 참조가 링크도 data-bare도 없이 적혀 있는지
        stripped = re.sub(r'<a\b[^>]*class="[^"]*srcref[^"]*"[^>]*>.*?</a>', "", frag, flags=re.S)
        for m in re.finditer(r"<code\b([^>]*)>([^<]*)</code>", stripped, flags=re.S):
            if "data-bare" in m.group(1):
                continue
            if FILELINE_RE.fullmatch(m.group(2).strip()):
                bare += 1
        for m in re.finditer(r'<div class="filename">(.*?)</div>', stripped, flags=re.S):
            inner = re.sub(r"<[^>]+>", "", m.group(1)).strip()
            if FILELINE_RE.fullmatch(inner) and "data-bare" not in m.group(1):
                bare += 1

        # 흐름 줄
        for line in prose.splitlines():
            if line.strip().startswith("흐름:") and len(line.strip()) > 120:
                warnings.append(
                    f"[{name}] '흐름:' 줄이 {len(line.strip())}자다: 이름만 화살표로 잇고 경로는 코드 블록 라벨로 보내라"
                )

        # 문장 단위
        long_ones, paren_ones = [], []
        for s in _sentences(prose):
            plain = re.sub(r"`[^`]*`", "X", s)
            if len(s) > LONG_SENTENCE and not s.startswith("흐름:"):
                long_ones.append(s)
            if plain.count("(") > MAX_PARENS:
                paren_ones.append(s)
        if long_ones:
            warnings.append(
                f"[{name}] {LONG_SENTENCE}자를 넘는 문장 {len(long_ones)}개. 예: {long_ones[0][:70]}…"
            )
        if paren_ones:
            warnings.append(
                f"[{name}] 괄호가 {MAX_PARENS + 1}개 이상인 문장 {len(paren_ones)}개. 예: {paren_ones[0][:70]}…"
            )

    if bare:
        warnings.append(
            f"링크도 data-bare 표시도 없는 소스 참조 {bare}개: <a class=\"srcref\">로 감싸거나 data-bare를 달아라"
        )

    # 언어 잔재와 말투
    visible = all_prose + "\n" + spec.get("provenance", "") + "\n" + spec.get("title", "")
    for word in ENGLISH_LEFTOVERS:
        if word in visible:
            warnings.append(f"영어 문구 '{word.strip()}'가 남아 있다")
    m = POLITE_ENDINGS.findall(all_prose)
    if m:
        warnings.append(f"해라체가 아닌 종결 {len(m)}개(예: '{m[0]}'): 문서는 '~한다'체로 통일한다")

    for pattern, label, advice in CALQUE_VERBS:
        hits = re.findall(pattern, all_prose)
        if hits:
            warnings.append(f"직역 동사 의심 '{label}' {len(hits)}회: {advice}로 바꿀 수 있는지 본다")

    # 한 낱말 여러 뜻: 앞말이 서로 다른 '묶음'
    prefixes = set(re.findall(r"([가-힣]+) 묶음", all_prose))
    if len(prefixes) > 3:
        warnings.append(
            f"'묶음'이 앞말 {len(prefixes)}가지와 쓰였다({', '.join(sorted(prefixes)[:6])}…): "
            "용어집에 정의된 말인지, 뜻이 겹치지 않는지 확인한다"
        )
    if "샘플" in all_prose and "표본" in all_prose:
        warnings.append("'샘플'과 '표본'이 함께 쓰였다: 하나로 통일한다")
    if "기본 형상" in all_prose and "기준 형상" in all_prose:
        warnings.append("'기본 형상'과 '기준 형상'이 함께 쓰였다: 뜻을 구분해 정의했는지 확인한다")
    return warnings


def render(spec: dict) -> str:
    validate_spec(spec)
    title = spec["title"]
    lead = spec.get("lead", "")
    provenance = spec.get("provenance", spec.get("subtitle", ""))
    sections = spec.get("sections", [])
    quiz = spec.get("quiz", [])
    language = spec.get("language", "ko")
    labels = UI_TEXT.get(language.split("-", 1)[0].lower(), UI_TEXT["en"])

    toc_items = "\n".join(
        f'  <li><a href="#{s["id"]}">{html.escape(s["heading"])}</a></li>' for s in sections
    )
    if quiz:
        toc_items += f'\n  <li><a href="#quiz">{html.escape(labels["quiz"])}</a></li>'

    body_sections = "\n\n".join(
        f'<h2 id="{s["id"]}">{html.escape(s["heading"])}</h2>\n{s["html"]}' for s in sections
    )

    quiz_html = ""
    if quiz:
        blocks = []
        for question_number, q in enumerate(quiz, start=1):
            options = list(q["options"])
            random.shuffle(options)
            rendered = []
            for option_number, option in enumerate(options, start=1):
                is_correct = option["correct"]
                feedback_id = f"feedback-{question_number}-{option_number}"
                result_label = labels["correct"] if is_correct else labels["incorrect"]
                rendered.append(
                    f'<button type="button" class="quiz-opt" '
                    f'data-correct="{"true" if is_correct else "false"}" '
                    f'aria-controls="{feedback_id}" aria-expanded="false">'
                    f'{inline_html(option["text"])}</button>\n'
                    f'<div id="{feedback_id}" class="feedback" role="status" aria-live="polite">'
                    f'<strong>{html.escape(result_label)}</strong> '
                    f'{inline_html(option["feedback"])}</div>'
                )
            blocks.append(
                f'<div class="quiz-q">\n<p><strong>{inline_html(q["question"])}</strong></p>\n'
                + "\n".join(rendered) + "\n</div>"
            )
        quiz_html = f'<h2 id="quiz">{html.escape(labels["quiz"])}</h2>\n\n' + "\n\n".join(blocks)

    lead_html = f'<p class="lead">{html.escape(lead)}</p>' if lead else ""
    prov_html = f'<p class="provenance">{html.escape(provenance)}</p>' if provenance else ""

    return f"""<!DOCTYPE html>
<html lang="{html.escape(language, quote=True)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{html.escape(title)}</title>
<link rel="stylesheet" href="{HIGHLIGHT_CSS_URL}">
<style>{CSS}</style>
</head>
<body>

<h1>{html.escape(title)}</h1>
{lead_html}
{prov_html}

<div class="toc">
<strong>{html.escape(labels["contents"])}</strong>
<ul>
{toc_items}
</ul>
</div>

{body_sections}

{quiz_html}

<script src="{HIGHLIGHT_JS_URL}"></script>
<script>if (window.hljs) hljs.highlightAll();</script>
<script>{QUIZ_JS}</script>

</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec", type=Path, help="JSON 콘텐츠 명세 경로")
    ap.add_argument("-o", "--output", type=Path, default=None, help="출력 HTML 경로")
    ap.add_argument("--strict", action="store_true", help="점검 경고가 있으면 종료 코드 1")
    ap.add_argument("--no-lint", action="store_true", help="한국어 점검을 건너뛴다")
    args = ap.parse_args()

    try:
        spec = json.loads(args.spec.read_text(encoding="utf-8"))
        out_html = render(spec)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        ap.error(str(exc))

    if args.output:
        out_path = args.output
    else:
        date_prefix = datetime.date.today().strftime("%Y-%m-%d")
        slug = spec.get("slug") or slugify(spec["title"])
        out_path = args.spec.parent / f"{date_prefix}-{slug}-explanation.html"

    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(out_html, encoding="utf-8")
    except OSError as exc:
        ap.error(str(exc))
    print(str(out_path))

    if not args.no_lint and spec.get("language", "ko").lower().startswith("ko"):
        warnings = lint(spec)
        if warnings:
            print(f"\n한국어 점검 경고 {len(warnings)}건:", file=sys.stderr)
            for w in warnings:
                print(f"  - {w}", file=sys.stderr)
            if args.strict:
                sys.exit(1)
        else:
            print("한국어 점검: 경고 없음", file=sys.stderr)


if __name__ == "__main__":
    main()
