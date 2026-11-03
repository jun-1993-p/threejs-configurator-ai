# 22: Docker 운영과 모델 예비 전환

**What to build:** 서버가 LAN의 로컬 Docker에서 무료·오픈소스 구성으로 돌고, LiteLLM이 Cerebras, 예비 Groq, 로컬 모델 사이에서 전환되며, 모델을 바꿔도 단계별 입출력 형식은 그대로다(ADR-0015).

**Blocked by:** 15 (LiteLLM 포트와 실제 명세 작성)

**Status:** ready-for-agent

- [x] 서버 전체가 Docker 구성 하나로 LAN에서 뜬다
- [x] API 키 등 비밀값은 저장소 밖 환경 파일로 주입된다
- [x] LiteLLM 설정만 바꿔 Cerebras, Groq, 로컬 모델(운영체제·기종 무관)로 전환된다 (실제 키로 도는 확인은 티켓 26 6절로 옮김)
- [x] 외부 API가 응답하지 않으면 예비 모델로 넘어간다
- [x] 모델을 바꿔도 같은 녹화본으로 경계 1 테스트가 통과한다

## Comments

### 2026-11-02 임베딩 모델 선택

- 사례 저장소(티켓 21)의 임베딩 모델 이름 `embedding`은 로컬 Ollama `embeddinggemma`(Gemma 3 기반, 308M, 768차원)에 건다. Cerebras·Groq에는 임베딩 API가 없어서 임베딩은 예비가 아니라 늘 로컬에서 돈다. 작은 모델이라 CPU로 충분하다.
- 확인: Ollama `/v1/embeddings`(`liteLlmEmbed`와 같은 형식)로 서랍장 사례 4개를 "3단 원목 서랍장 / 폭과 높이만 조절, 칸 수 고정"으로 검색했다. 같은 3단 원목 사례 0.900, 5단 칸 수 선택 0.770, 철제 서류 서랍장 0.715, 1단 협탁형 0.665로 순위가 상식에 맞았다.
- 앞붙임 문구("task: … | query: …")는 쓰지 않는다. 정보 입력 문장끼리 비교하므로 양쪽이 같은 형식이면 된다.
- 다른 후보: `bge-m3`(568M, 1024차원). Gemma 2 기반 `bge-multilingual-gemma2`(9B)는 사례 수십 개의 짧은 문장 비교에 지나치게 커서 쓰지 않는다. 모델을 바꾸면 `lanceCaseStore`가 벡터 길이 변화를 보고 색인을 다시 만든다.

### 2026-11-02 구현

- Docker 구성: 저장소 루트 `docker-compose.yml` 하나에 `server`(업로드 서버, 8000), `litellm`(모델 중계, 4000), `ollama`(로컬 모델, 포트를 열지 않음), `pipeline`(실행 도구, `tools` 프로필이라 `docker compose run --rm pipeline …`으로만 돈다). 이미지 안 배치는 저장소와 같게 `/app` 아래에 두어 `schema/`·`data/`를 같은 상대 경로로 찾는다. `data/`·`fixtures/`는 컨테이너 밖 폴더를 연결한다. 운영 안내는 `docs/docker.md`.
- 비밀값: `.env`(저장소 밖, `.gitignore` 대상)에서 compose가 읽어 `litellm` 환경에 넣는다. 예시는 `.env.example`. `LITELLM_MASTER_KEY`가 없으면 compose가 시작하지 않는다(키 없는 프록시가 LAN에 열리지 않게). `.dockerignore`로 `.env`·`data/`·`fixtures/`를 이미지에서 뺐다.
- LiteLLM 설정: `docker/litellm/config.yaml`. 파이프라인이 부르는 `llm`·`vlm`·`embedding` 이름 뒤에 Cerebras(`gpt-oss-120b`, VLM은 `docs/plan.md`의 `qwen3.8-27b`) → Groq(`openai/gpt-oss-120b`, `meta-llama/llama-4-scout-17b-16e-instruct`) → 로컬(`gpt-oss:20b`, `qwen3-vl:8b`) 순서로 예비를 둔다(`router_settings.fallbacks`, 120초 넘으면 응답하지 않는 것으로 본다). 로컬 모델은 Ollama 전용 공급자 대신 OpenAI 호환(`openai/…` + `LOCAL_MODEL_URL`)으로 불러, Ollama·LM Studio·llama.cpp 어느 것이든, 어느 운영체제·기종이든 주소만 바꾸면 된다. 임베딩은 따로 `EMBEDDING_MODEL_URL`.
- 시험: `docker/tests/test_litellm_config.py`(pytest, `testpaths`와 커밋 전 검사에 `docker/` 추가) — 파이프라인의 모델 이름이 있는지, `llm`·`vlm`이 Groq 다음 로컬로 넘어가는지, 임베딩이 로컬인지, 로컬은 OpenAI 호환 주소를 환경에서 받는지, 키가 모두 `os.environ/`인지. 개발 의존성에 `pyyaml`·`types-PyYAML`.
- 경계 1(`litellm-ai.test.ts`): 모델을 바꾸면 같은 단계에 다른 모양의 답이 온다. 추론을 `reasoning` 필드에 싣는 gpt-oss(Cerebras·Groq), LiteLLM이 옮긴 `reasoning_content`, content 앞에 `<think>` 블록을 붙이는 로컬 추론 모델마다 같은 합성 서랍장 녹화본으로 제출까지 가는 시험 3개와, 추론만 하다 끝나 content가 null인 답을 형식 오류로 다시 묻는 시험을 더했다. 포트는 `<think>` 블록을 벗기고 null을 빈 문장으로 읽는다(전에는 `<think>`가 붙으면 형식 오류를 되풀이했다).

### 2026-11-02 수동 확인 기록

- 예비 전환(저장소 `.venv`의 LiteLLM 1.106.6 프록시, 이 설정을 복사해 로컬 모델만 받아 둔 `qwen2.5:3b`로 바꿈, Cerebras·Groq 키는 가짜): `llm` 호출이 `x-litellm-model-group: llm-local`로 답했다. Cerebras 주소를 받기만 하고 답하지 않는 소켓으로 바꾸고 제한 시간을 5초로 줄이자 9초 만에 `llm-local`이 답했다. `embedding`은 768차원 벡터를 냈다.
- Docker(Docker Desktop 29.9.2, Windows 11): `docker compose up -d --build`로 셋이 떴고, LAN 주소(192.168.0.203)에서 서버 `/health`, LiteLLM `/health/liveliness`, `embedding` 호출(컨테이너 ollama의 `embeddinggemma`)이 답했다. `pipeline` 컨테이너에서 전체 시험 185개 중 184개 통과, 실패 1개는 `git check-ignore`를 부르는 "기본 사례 저장소 폴더는 공개 저장소에 올라가지 않는다"로, 이미지에 git과 `.git`이 없어서다(이미지 안 동작과 무관해 그대로 둔다).
- Windows 호스트에서 LiteLLM을 직접 돌리면 기본 문자 집합(cp949) 때문에 한국어 주석이 든 설정을 읽지 못한다. `PYTHONUTF8=1`을 주면 된다. 컨테이너(리눅스)는 해당 없다.
- 남은 일: Cerebras·Groq 실제 키로 이 순서가 도는지, `qwen3.8-27b`가 Cerebras의 실제 모델 이름인지는 실제 키가 필요해 티켓 26(Fusion 실물 확인)에서 본다. 로컬 `gpt-oss:20b`·`qwen3-vl:8b`는 받지 않아(약 13GB·6GB) 로컬 채팅 예비는 `qwen2.5:3b`로만 확인했다.

### 리뷰 뒤 반영과 남긴 것

- 반영:
  - 설정 시험 이름을 한국어 용어로 바꿨다(`server/tests` 관례, "폴백" 대신 예비 모델).
  - 로컬 모델 판정을 `api_base` 대신 `api_key: local` 표지로 했다.
  - 설정 주석의 "UI 스타일"을 "스타일 선택"으로 고쳤다.
  - 설정 머리말은 까닭만 남기고 운영 설명은 `docs/docker.md`로 넘겼다.
  - `num_retries: 0`으로 바꿨다. 다시 물으면 응답하지 않는 외부 API를 120초씩 두 번 기다린다. 수동 확인 때는 이미 0으로 돌렸다.
  - 파이프라인의 LiteLLM 호출에 제한 시간을 뒀다(`timeoutMs`, 기본 20분). 전에는 Node fetch의 기본 헤더 제한 300초에 걸려, 외부 둘(240초) 뒤 로컬 모델이 답하는 중에 파이프라인이 끊길 수 있었다. undici `Agent`로 자체 제한을 끄고 `AbortSignal.timeout`으로 기다린다. 넘기면 "LiteLLM이 N초 안에 답하지 않았습니다(모델)"로 실패한다. 시험 1개 추가. 의존성 `undici` 7.29.1은 Node 24에 든 것과 같은 판이다.
  - `.env.example`의 프록시 키를 비웠다. 예시 값을 그대로 쓰면 알려진 키로 LAN에 열린다.
  - 이미지를 고정했다. LiteLLM은 판 번호 태그가 없어 확인한 1.106.6의 `main-stable` digest로, Ollama는 `0.40.13`으로 고정했다.
- 남긴 것:
  - 기본 로컬 주소 `http://ollama:11434/v1`가 compose 두 줄(`LOCAL_MODEL_URL`·`EMBEDDING_MODEL_URL`)과 `.env.example` 주석에 있다. compose 값 바꿔 넣기(`${…:-…}`)는 YAML 앵커를 쓸 수 없고, 예시 파일의 주석은 운영자가 기본값을 알게 하려는 것이다.
  - 상태 줄은 다른 끝난 티켓과 같이 `ready-for-agent`로 둔다.
