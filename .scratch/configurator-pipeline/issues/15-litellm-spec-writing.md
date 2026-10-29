# 15: LiteLLM 포트와 실제 명세 작성

**What to build:** 각본 AI 대신 LiteLLM을 거친 실제 LLM이 명세를 쓰고, 검증 피드백을 받아 고친다. 모든 AI 응답은 JSON Schema 검사를 거치고, 형식이 틀린 응답은 다음 단계로 가지 않는다(ADR-0001, 0015).

**Blocked by:** 04 (수치 검증과 검증 피드백 루프)

**Status:** ready-for-human

- [x] AI 모델 포트의 LiteLLM 구현이 있고, 각본 가짜와 바꿔 끼울 수 있다
- [x] 명세 작성 단계가 업로드 묶음·선택된 후보·정보 입력을 입력으로 받아 명세 JSON을 낸다
- [x] JSON Schema 검사에 실패한 응답은 재요청되고, 다음 단계로 새지 않는다
- [x] 검증 피드백을 받은 명세 작성이 `path`가 가리키는 곳을 고쳐 다시 낸다
- [ ] 실제 상품 하나로 실제 모델을 써서 수치 검증까지 통과하는 수동 확인 기록이 있다

## Comments

### 2026-10-29 구현

- AI 모델 포트의 LiteLLM 구현: `configurator/pipeline/litellm-ai.ts`의 `liteLlmAi({ baseUrl, apiKey, models })`. LiteLLM 프록시의 OpenAI 호환 `v1/chat/completions` 하나만 부르고, 단계(후보 제시·UI 스타일·명세 작성)마다 LiteLLM 설정의 `model_name`을 받는다. 실제 모델 전환은 LiteLLM 설정 몫이다(ADR-0015).
- JSON 모드처럼 특정 API에만 있는 기능에 기대지 않는다. 출력 형식은 지시문에 JSON Schema를 적어 알리고, 스키마 안의 `$ref`는 풀어서 보낸다(작은 모델이 `{"$ref": …}`를 값의 모양으로 옮겨 적었다).
- 업로드 묶음은 4MB라 그대로 보내지 않는다. `bundleForPrompt`가 파라미터(이름·값·수식·사용자/개수형 여부), 부품별 기본 형상 바운딩 박스, 스윕 범위·범위 축소 기록·위상 묶음 수로 줄인다(서랍장 녹화본 요청이 20KB 아래).
- 형식 검사와 다시 묻기는 그대로 실행기가 한다. 포트는 모델이 낸 문장을 JSON으로 읽어 돌려주고(코드 블록으로 감싼 것은 벗김), 읽을 수 없으면 문장 그대로 돌려준다. 실행기는 문자열 응답을 "JSON으로 읽을 수 없는 답" 형식 오류로 다시 묻는다.
- AI 모델 포트 입력에 다시 묻기에 쓸 직전 응답을 더했다. `rejected`는 형식 검사에 걸린 직전 답(세 단계 모두), `previous`는 검증 피드백을 받은 명세(명세 작성만)다. 형식 재요청 중에도 `previous`는 피드백을 받은 명세 그대로다. 실제 모델은 직전 명세가 없으면 `path`가 가리키는 곳만 고칠 수 없다.
- 형식 오류 문장에 값 목록(enum) 밖이면 고를 수 있는 값을 붙인다(`must be equal to one of the allowed values (X, Y, Z)`). 실제 모델이 값 목록을 모른 채 같은 오류를 되풀이했다.
- 명세 검사에 정면과 축 대응 검사(`axesChecker`)를 더했다. 깊이(D)는 정면 방향의 축, W·D·H는 서로 다른 축이어야 한다. 축 반응 검증은 명세의 `axes`로 재기 때문에, 정면이 `+X`인데 `axes.W`가 X인 명세가 수동 확인에서 제출까지 갔다.
- 후보 제시·UI 스타일 지시문도 넣었다. 포트를 통째로 바꿔 끼우려면 세 메서드가 다 있어야 해서다. 티켓 16(후보 비교·미리보기·VLM 부품 탐색)과 18(스타일 목록·적용)을 끝낸 것은 아니다. VLM 분리도 그쪽에서 한다.
- 시험: `configurator/test/litellm-ai.test.ts`. 경계 1에서 AI 모델 포트만 LiteLLM 구현으로 바꾸고 OpenAI 호환 가짜 HTTP 서버를 둔다. 8개(제출까지, 요청 내용, 읽을 수 없는 답, 검증 피드백, 피드백 중 형식 오류, 주소 경로, 코드 블록, LiteLLM 오류). `pipeline.test.ts`에 enum 허용값과 정면·축 검사 2개를 더했다.
- 수동 실행 도구: `node scripts/run-pipeline.ts <업로드 묶음> <정보 입력> <치수 규칙> <출력 폴더>`(환경 변수 `LITELLM_URL`·`LITELLM_API_KEY`·`LITELLM_MODEL`). 애드인 연결이 없으므로 슬라이더 하나짜리 후보를 고르고 바로 승인한다. 그런 후보가 없으면 멈춘다.

### 2026-10-29 수동 확인 기록 (실제 상품은 아직)

- 조건: 실제 LiteLLM 프록시(`litellm[proxy]`, `.venv`) 뒤에 로컬 Ollama `qwen2.5:7b`(ADR-0015의 로컬 예비 경로). Cerebras·Groq 키가 없고, 실제 상품 녹화본(`fixtures/private/`)도 없어서 **합성 서랍장 녹화본 `fixtures/synthetic/drawer.json`**으로 돌렸다.
- 정보 입력: 1단 서랍장 / 서랍장 / "슬라이더는 전체 폭 하나만. 폭 400~800" / 두께 숨김. 치수 규칙: 서랍장 폭(W 300~1200)·깊이(D 250~700)·높이(H 300~1200).
- 통과한 실행(리뷰 반영 전 코드, 정면·축 검사 추가 전): 후보 2개 → 후보 1 선택 → 스타일 natural → 명세 형식 오류(`/sliders/0/min` 교집합 400~800 밖의 300) → 다시 쓴 명세 조립 → 축 반응 피드백 `sliders[0].affects.shape`(DrawerBox, unexpected_shape_change) → 고친 명세로 수치 검증·축 반응 통과 → 승인 → 제출. 다만 최종 명세가 정면 `+X`에 `axes.W` X여서, 이를 거르는 정면·축 검사를 더했다.
- 리뷰 반영 뒤 실행: 7b 모델이 메모를 무시하고 슬라이더 여러 개짜리 후보만 내거나(도구가 멈춤), 정면을 `+X`로 잡고 축 오류를 세 번 다시 물어도 못 고쳐 명세 단계에서 멈췄다. 형식 오류는 매번 다음 단계로 새지 않았다. 7b 로컬 모델로는 정면·축까지 맞는 명세가 안정적으로 나오지 않는다.
- 남은 일(사람): 실제 상품 하나를 녹화하고(`docs/recording-guide.md`), Cerebras 키로 `gpt-oss-120b`를 LiteLLM에 걸어 `scripts/run-pipeline.ts`로 수치 검증까지 통과하는지 확인해 이 아래에 기록한다. 그래서 상태를 `ready-for-human`으로 둔다.

### 리뷰 뒤 반영과 남긴 것

- 반영: 위 `previous`/`rejected` 분리, 정면·축 검사, 실행 도구의 후보 고르기, AI 단계 타입을 실행기(`AI_STAGES`)에서 함께 쓰기, 형식 오류 위치 `(최상위)`와 읽을 수 없는 답 문장을 `schemas.ts`에 모으기, `styleChoiceChecker`를 같은 파일의 `function` 관용으로, 실행기 명세 호출의 타입 이중 표기 정리, 위상 묶음 수의 `+1` 설명, 시험의 처리 기록 위치 고정(`slice(5, 9)`)을 단계로 거르기로, LiteLLM 주소에 붙은 경로 유지, 실행 도구를 `build.ts` 형태(`import.meta.main`)로 바꾸고 처리 기록은 메모리 저장소의 `onLog`로 받기.
- 남긴 것:
  - `rejected`·`schemaErrors`를 한 타입으로 묶지 않았다. 기존 시험 수십 곳이 `calls.spec[i].schemaErrors`를 읽고, 세 단계 입력이 평평한 기존 모양을 유지하는 편이 각본 가짜와 맞다.
  - `litellm-ai.test.ts`가 `pipeline.test.ts`의 `intake`·`approveFirst`·`offline`과 비슷한 값을 따로 둔다. 시험 파일마다 입력을 한눈에 보이게 하는 기존 관례이고, 정보 입력 메모·치수 규칙이 다르다.
  - 시험 머리 주석의 "경계 1"은 명세(spec.md 시험 결정)에 붙은 이름이라 그대로 쓴다.
  - `SPEC_SCHEMA`·`CANDIDATES_SCHEMA`(상수)와 `styleChoiceSchema`(스타일 목록을 받는 함수)의 표기 차이는 상수/함수 구분이라 둔다.
