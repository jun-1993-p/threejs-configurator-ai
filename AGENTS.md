# 프로젝트 개요

Fusion CAD 모델을 쇼핑몰용 three.js 구성기(div)로 만드는 1인 프로젝트다.
답변과 문서는 한국어로 쓴다. 내부 약어 코드(A1, B3 등) 대신 이름으로 쓴다.

## Agent skills

### Issue tracker

이슈는 로컬 마크다운(`.scratch/<기능>/`)으로 관리한다. 자세한 내용은 `docs/agents/issue-tracker.md` 참고.

### Triage labels

기본 5개 라벨(`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`)을 그대로 쓴다. 자세한 내용은 `docs/agents/triage-labels.md` 참고.

### 검사와 합성 녹화본

- 작업 중 Python 시험은 `.venv/Scripts/python -m pytest -m "not solidcraft"`(몇 초)로 돌린다. 전체 시험과 mypy는 커밋 전 검사(`.githooks/pre-commit`)가 돌린다.
- SolidCraft로 시험용 모델과 합성 녹화본을 만들 때는 `docs/recording-guide.md` 9절을 따른다.

### Domain docs

단일 컨텍스트(루트 `GLOSSARY.md` + `docs/adr/`). 자세한 내용은 `docs/agents/domain.md` 참고.
