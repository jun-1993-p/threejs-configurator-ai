# 26: Fusion 실물 확인

**What to build:** Fusion이 있어야만 할 수 있는 확인을 한곳에 모은다. 다른 티켓은 SolidCraft 합성 녹화본(티켓 24, 25)으로 끝내고, 이 티켓만 Fusion에 접근할 수 있을 때 사람이 처리한다. 확인에서 합성 녹화본과 어긋나는 점이 나오면 Fusion 어댑터(`addin/ConfiguratorUploader/uploader/fusion_model.py`)와 녹화본 쪽에서 고치는 것이 원칙이다.

**Blocked by:** None (can start immediately)

**Status:** ready-for-human

### 1. 면·모서리 이름과 점 추출 (티켓 25에서 옮김)

- [ ] Fusion 애드인에서 피처 기준 면 이름을 만들 수 있는지, 경계 맞춤 격자와 같은 방식으로 점을 추출할 수 있는지 확인한다
- [ ] 확인되면 `fusion_model.py`의 `sample_edges`(지금은 `NotImplementedError`)를 구현한다. 평면·원기둥 면은 `geometry`도 낸다(티켓 04, 업로드 묶음 스키마 필수)

### 2. 첫 업로드와 녹화 (티켓 01에서 옮김)

- [ ] stool1 또는 실제 상품 하나로 만든 녹화본이 있고, 실제 상품 데이터는 공개 저장소에 올라가지 않는 위치(`fixtures/private/`)에 둔다. 절차는 `docs/recording-guide.md`
- [ ] 어셈블리 프록시 면의 점이 어셈블리 좌표로 나온다
- [ ] `getPointsAtParameters` 반환 형식이 어댑터가 기대하는 대로다
- [ ] 재계산 실패 판정(업로드 전 오류 수 대비 증가)이 맞다
- [ ] 같은 컴포넌트를 여러 번 넣은 경우(좌·우 측판) 오커런스마다 다른 부품이 되는 것이 의도와 맞는지 정한다(ADR-0006을 인스턴스 단위로 해석한 것)

### 3. 업로드 뒤 연결 (티켓 08)

- [ ] 업로드 뒤 애드인이 연결된 채로 교차 검증 샘플 요청에 답하고, Fusion을 닫으면 "Fusion 연결 필요"가 되었다가 다시 열면 이어진다(사용자 이벤트·일꾼 스레드)

### 4. 이후 티켓용 실물 녹화본 (녹화 안내서 8절)

합성 녹화본으로 끝낸 티켓이 Fusion 실물에서도 맞는지 본다. 한 상품이 여러 항목을 채워도 된다.

- [ ] 비선형으로 변하는 부분이 있는 모델(티켓 05 적응형 스윕, 재계산 실패 지점의 스윕 범위 축소 포함, 합성은 `fixtures/synthetic/bench-tilt.json`). Fusion 어댑터가 바디 부피(`measure_bodies`)도 내서 `volume_jump` 경고가 Fusion 업로드에서도 나오게 할지 정한다
- [ ] 한 축에 슬라이더가 둘인 모델(티켓 06 축 반응 검증)
- [ ] 두 슬라이더가 서로 영향을 주는 모델(티켓 09 격자 보강)
- [ ] 폭에 따라 칸막이 수가 바뀌는 모델(티켓 11 위상 묶음, 합성은 `fixtures/synthetic/shelf.json`)
- [ ] 판재 두께가 수식에 섞인 모델(티켓 13 두께 고정 실측)

### 5. 실제 상품으로 실제 모델 확인 (티켓 15에서 옮김)

- [ ] 실제 상품 하나로 실제 모델을 써서 수치 검증까지 통과하는 수동 확인 기록이 있다. LiteLLM에 Groq `gpt-oss-120b`를 걸고 `scripts/run-pipeline.ts`로 돌린다. 기록은 이 티켓 아래에 남긴다

### 6. 실제 키로 예비 모델 전환 확인 (티켓 22에서 옮김)

Docker 구성(`docs/docker.md`)을 띄우고 `.env`에 실제 키를 넣어 확인한다. 어느 모델이 답했는지는 LiteLLM 응답 헤더 `x-litellm-model-group`으로 본다.

- [x] Groq 키로 `llm`·`vlm`이 실제로 답한다(헤더가 `llm`·`vlm`)
- [x] `docker/litellm/config.yaml`의 Groq 모델 이름(`openai/gpt-oss-120b`, `meta-llama/llama-4-scout-17b-16e-instruct`)이 Groq 모델 목록에 있다. 아니면 설정을 고친다
- [x] ~~Groq 키를 비우면 로컬 모델이 답한다~~ 로컬 예비를 뺐다(ADR-0015 바뀐 것). 개발 PC에서 로컬 LLM·VLM이 15분 안에 답하지 못했다(아래 세 번째 기록)
- [ ] Groq로 `scripts/run-pipeline.ts`를 합성 서랍장 녹화본 `fixtures/synthetic/drawer.json`으로 돌려, 형식 오류가 다음 단계로 새지 않는지 처리 기록(`log.json`)으로 본다

## Comments

- 2026-11-02: Fusion에 접근할 수 없는 동안 사람 확인이 티켓 01·15·25에 흩어져 있어, 코드가 끝난 티켓 15가 16·18·19·22를 막고 있었다. 사람 확인을 이 티켓으로 모으고 원래 티켓은 코드 완료로 둔다.
- 5절 중 Fusion이 필요 없는 부분(큰 모델로 정면·축까지 맞는 명세가 나오는지)은 Groq 키만 있으면 합성 서랍장 녹화본 `fixtures/synthetic/drawer.json`으로 먼저 볼 수 있다. 로컬 7b 모델로는 안정적으로 나오지 않았다(티켓 15 수동 확인 기록).
- 2026-11-03: Cerebras 가입에 카드 등록이 필요해 Cerebras를 빼고 Groq를 첫 모델로 바꿨다(ADR-0015 바뀐 것). 6절 항목을 Groq → 로컬 순서로 고쳤다. 6절 확인 절차는 `scripts/fallback-check-wizard.sh`가 안내한다.

### 2026-11-03 6절 첫 실행

- 모델 이름: Groq 모델 목록에 `meta-llama/llama-4-scout-17b-16e-instruct`가 없어 `vlm`을 `groq/qwen/qwen3.8-27b`로 바꿨다. `openai/gpt-oss-120b`는 목록에 있다.
- 헤더: 위저드가 두 회차 모두 "답 없음"을 찍었다. 위저드가 Git Bash 경로 변환을 대본 전체에서 꺼서 Windows용 curl이 임시 파일을 찾지 못한 탓이다. 변환은 컨테이너 명령에서만 끄게 고쳤다. 고친 함수로 실제 Groq에 물어 `llm` → `llm`, `vlm` → `vlm`을 받았다.
- 파이프라인: 두 회차 모두 부품 탐색에서 끊겼다. 위저드가 오류 출력을 남기지 않아 다시 돌려 봤다(위저드가 이제 오류 줄도 남긴다).
  - Groq VLM은 요청 하나에 그림을 3장까지만 받는다. 부품 탐색은 6장을 보낸다. 모음 그림으로 묶는 일을 티켓 27로 만들었다.
  - 예비 `vlm-local`은 Ollama 기본 문맥 길이 4096 토큰을 넘었다(4662). 구성의 `ollama`에 `OLLAMA_CONTEXT_LENGTH: 16384`를 두었다.
- 남은 일: 티켓 27 뒤에 위저드를 다시 돌려 로컬 예비와 파이프라인 항목을 본다.

### 2026-11-03 6절 두 번째 실행(티켓 27 뒤)

- 1회차(Groq): 모음 그림으로 부품 탐색이 Groq VLM의 그림 수 제한을 넘었다. 형식 오류로 두 번 다시 물었다(정면 후보에 위쪽과 같은 축 `-Z`를 냄, 다음 답은 필드가 빠짐).
  - 세 번째 물음에서 Groq 무료 등급 VLM의 분당 입력 토큰 제한(7,000)에 걸렸다. 부품 탐색 요청 하나가 약 2,750토큰이다. 설정이 다시 묻지 않고(`num_retries: 0`) 바로 `vlm-local`로 넘어갔다.
  - `vlm-local`(`qwen3-vl:8b`)은 CPU에서 프롬프트를 초당 1.8토큰으로 읽다가 9분 40초 만에 그림을 읽는 중 죽었다(Docker 메모리 7.7GB). 같은 때 `docker compose run`도 연결을 잃어("unexpected EOF") 위저드가 회차 결과를 남기지 못했다.
- 고친 것:
  - LiteLLM이 속도 제한(429)만 Groq가 알려 준 대기 시간을 기다려 3번까지 다시 묻는다(`retry_policy`). 다른 오류는 지금처럼 바로 예비로 넘어간다. `num_retries`가 0이면 LiteLLM이 `retry_policy`를 보지 않아 3으로 두었다. 컨테이너 안 Router에 같은 설정과 가짜 응답을 넣어, 속도 제한은 앞 모델을 4번 부른 뒤 예비로 넘어가고 서버 오류는 1번 부르고 넘어가는 것을 봤다.
  - 로컬 예비 VLM을 `qwen3-vl:4b`로 낮췄다(운영자 결정). 위저드·`docs/docker.md`·`docs/plan.md`도 고쳤다.
- 걱정: 로컬 예비 LLM `gpt-oss:20b`(약 13GB)도 Docker 메모리 7.7GB에 들지 않는다. 2회차 후보 제시에서 같은 식으로 죽을 수 있다.
- 남은 일: 위저드를 다시 돌린다.

### 2026-11-03 로컬 예비 측정과 포기

운영자가 당분간 이 개발 PC(i7-4770, 메모리 16GB 중 Docker 7.7GB, GPU 없음)에서만 시험한다고 정했다. 로컬 예비를 이 사양에 맞추되, 요청마다 15분 안에 죽지 않고 답하고 파이프라인이 제출까지 가지 못하면 포기하기로 했다. Groq 키를 비운 LiteLLM으로 합성 서랍장을 돌렸다(`data/runs/local-check/`).

- `qwen3-vl:8b`: 부품 탐색 그림을 읽다 9분 40초 만에 죽었다(두 번째 실행 기록).
- `qwen3-vl:4b`: 프롬프트는 초당 27토큰으로 읽었으나 이 판은 추론(thinking)이 기본이라 답 앞에 추론을 2,475토큰(초당 3.2토큰) 쓰다 15분 제한에 걸렸다.
- `qwen3-vl:4b-instruct`: 14분 30초 동안 모델을 올리지 못했다("timed out waiting for llama-server to start"). 끝에 `docker compose run`이 다시 연결을 잃었다.
- 로컬 LLM(`qwen3:4b-instruct`)은 부품 탐색을 넘지 못해 재지 못했다. `gpt-oss:20b`(13GB)는 메모리에 들지 않는다.
- 결정: 로컬 예비 LLM·VLM을 뺐다(ADR-0015 바뀐 것). LiteLLM 설정에서 `llm-local`·`vlm-local`과 `fallbacks`를, 구성에서 `LOCAL_MODEL_URL`·`OLLAMA_CONTEXT_LENGTH`를 뺐다. 임베딩(`embeddinggemma`)은 그대로 로컬이다. 위저드는 Groq 회차만 돈다.
- 따로 찾은 것: `docker compose run`은 의존 서비스(litellm)를 `.env` 설정으로 다시 만든다. 위저드처럼 litellm을 다른 환경으로 띄운 뒤 부르면 재시작 중에 연결이 거부된다. 위저드의 파이프라인 실행에 `--no-deps`를 붙였다.
- 남은 일: 위저드를 다시 돌려 Groq 회차의 파이프라인 항목을 본다.

### 2026-11-03 6절 Groq 회차(로컬 예비를 뺀 뒤)

- `llm` → `llm`, `vlm` → `vlm`. 부품 탐색은 Groq에서 한 번에 통과했다.
- 후보 제시에서 멈췄다. 정보 입력(메모 "슬라이더는 전체 폭 하나만", 두께 선택 숨김)과 부품 탐색(정면 하나)이 구성을 하나로 정했는데 후보는 서로 다른 2개 이상이어야 해, 모델이 "두께 선택 노출이 정보 입력과 다름"과 "후보끼리 모두 같음"을 오갔다. 운영자 결정으로 그럴 때 후보 하나를 받게 했다(티켓 28).
- 남은 일: 위저드를 다시 돌린다.
