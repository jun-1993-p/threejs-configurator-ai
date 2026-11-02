# 22: Docker 운영과 모델 예비 전환

**What to build:** 서버가 LAN의 로컬 Docker에서 무료·오픈소스 구성으로 돌고, LiteLLM이 Cerebras, 예비 Groq, 로컬 모델 사이에서 전환되며, 모델을 바꿔도 단계별 입출력 형식은 그대로다(ADR-0015).

**Blocked by:** 15 (LiteLLM 포트와 실제 명세 작성)

**Status:** ready-for-agent

- [ ] 서버 전체가 Docker 구성 하나로 LAN에서 뜬다
- [ ] API 키 등 비밀값은 저장소 밖 환경 파일로 주입된다
- [ ] LiteLLM 설정만 바꿔 Cerebras, Groq, 로컬 모델(운영체제·기종 무관)로 전환된다
- [ ] 외부 API가 응답하지 않으면 예비 모델로 넘어간다
- [ ] 모델을 바꿔도 같은 녹화본으로 경계 1 테스트가 통과한다

## Comments

### 2026-11-02 임베딩 모델 선택

- 사례 저장소(티켓 21)의 임베딩 모델 이름 `embedding`은 로컬 Ollama `embeddinggemma`(Gemma 3 기반, 308M, 768차원)에 건다. Cerebras·Groq에는 임베딩 API가 없어서 임베딩은 예비가 아니라 늘 로컬에서 돈다. 작은 모델이라 CPU로 충분하다.
- 확인: Ollama `/v1/embeddings`(`liteLlmEmbed`와 같은 형식)로 서랍장 사례 4개를 "3단 원목 서랍장 / 폭과 높이만 조절, 칸 수 고정"으로 검색했다. 같은 3단 원목 사례 0.900, 5단 칸 수 선택 0.770, 철제 서류 서랍장 0.715, 1단 협탁형 0.665로 순위가 상식에 맞았다.
- 앞붙임 문구("task: … | query: …")는 쓰지 않는다. 정보 입력 문장끼리 비교하므로 양쪽이 같은 형식이면 된다.
- 다른 후보: `bge-m3`(568M, 1024차원). Gemma 2 기반 `bge-multilingual-gemma2`(9B)는 사례 수십 개의 짧은 문장 비교에 지나치게 커서 쓰지 않는다. 모델을 바꾸면 `lanceCaseStore`가 벡터 길이 변화를 보고 색인을 다시 만든다.
