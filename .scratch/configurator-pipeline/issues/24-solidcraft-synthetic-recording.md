# 24: SolidCraft 합성 녹화본

**What to build:** Fusion 실물 확인이 어려운 동안 쓸 합성 녹화본을 SolidCraft로 만든다. 스크립트가 `solidcraft-cli run`으로 SolidCraft 모델의 사용자 파라미터를 단독 스윕하고, 업로드 묶음 스키마(`schema/upload-bundle.schema.json`)에 맞는 파일을 낸다. 평면과 원기둥 면만 다룬다. 서버는 이 파일을 녹화본과 똑같이 받아들인다.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] 스크립트가 `.sc` 모델 하나를 받아 사용자 파라미터마다 기본값 ±50% 5점 단독 스윕을 돌리고, 원본 모델은 바꾸지 않는다
- [x] 사용자 파라미터가 아닌 스케치 치수(예: 서랍장의 서랍 높이 `d6`)도 이름을 넘기면 함께 스윕한다
- [x] 업로드 묶음 스키마에 선택 필드 `source`, 면 이름, 모서리(이름과 끝점), 샘플별 부피·바운딩 박스를 더한다. 스키마가 `additionalProperties: false`라서 필요하다. 기존 녹화본은 계속 유효하다
- [x] 결과 파일이 업로드 묶음 스키마 검사를 통과하고, 만든 도구가 `source: "solidcraft"`로 적힌다
- [x] 면마다 SolidCraft의 면 이름을, 모서리마다 `면A|면B` 이름을 그대로 담는다
- [x] 평면·원기둥이 아닌 면이 있으면 그 면 이름과 함께 오류를 내고 파일을 쓰지 않는다
- [x] 샘플마다 부피와 바운딩 박스를 담는다(티켓 05의 `volume_jump`, 티켓 10의 위상 비교에 쓴다)
- [x] `solidcraft-test/drawer.sc`로 만든 서랍장 합성 녹화본이 저장소에 있다

## Comments

- 근거: `solidcraft-test/report.md` 6절, ADR-0016. 점 배치는 티켓 25에서 경계 맞춤 격자로 바뀐다. 이 티켓에서는 면·모서리 이름과 경계 모서리 끝점을 빠짐없이 담는 데 집중한다.
- SolidCraft MCP는 허용 폴더 밖 쓰기를 막지만 `solidcraft-cli`는 그렇지 않다. 실행 파일: `C:\Program Files\SolidCraft\solidcraft-cli.exe`.
- `inspect.parameter_sweep`는 형상 오류를 ok로 보고하므로 쓰지 않는다. `parameters.change`로 값을 직접 바꾼다.

### 2026-10-29 구현

- 실행: `python -m synthetic.make_recording solidcraft-test/drawer.sc --extra d6 --out fixtures/synthetic/drawer.json` (저장소 루트, `.venv`). 결과: `fixtures/synthetic/drawer.json`, 사용자 파라미터 4개(`body_w`, `body_d`, `body_h`, `drawer_d`)와 `d6`의 25개 샘플.
- 코드: `synthetic/solidcraft_model.py`(애드인 핵심의 `FusionModel`처럼 동작하는 어댑터), `synthetic/grid.py`(평면·원기둥 n×n 격자), `synthetic/make_recording.py`. 스윕 순서와 묶음 구성은 애드인 핵심 `run_upload`를 그대로 쓴다.
- 애드인 핵심: `run_upload`에 `source`(기본 `fusion`)와 `extra_sweeps`가 생겼다. 모델이 `TopologyModel`(모서리·바디 측정값)이면 샘플마다 `edges`와 `bodies`를 담는다. Fusion 어댑터는 바뀌지 않았다.
- 스키마: 선택 필드 `source`, 면 `name`·`geometry`, 샘플 `edges`·`bodies`. 기존 묶음은 그대로 유효하다.
- 모서리 이름을 나눌 때 주의: 필렛 면 이름(`F3:blend:F1:-x|F1:-y`)에도 세로선이 있다. 면 이름 목록에 맞는 자리에서 나눈다(`edge_faces`).
- SolidCraft는 속 비우기가 실패해도 피처 오류를 내지 않는다(`body_d=10`에서 면만 줄고 오류 없음). 그래서 `recompute_failed`는 피처 오류가 있을 때만 붙고, 조용한 실패는 티켓 10의 위상 비교 몫이다.
- 만들다가 찾은 모델 오류: 몸통 속 비우기 면 지정점 (0, 0, 350)이 `body_h=350`에서 윗모서리 위에 놓여 면이 11개에서 10개로 줄었다(몸통 부피 13,608,864 mm³, 손 계산 17,994,528 mm³). 서랍과 같은 방식으로 높이와 무관한 (0, 0, 9)로 고쳤다. 이제 25개 샘플 모두 면 22개이고 부피가 손 계산과 일치한다. 통합 테스트(`synthetic/tests/test_make_recording.py`)가 이 조건을 확인한다.
