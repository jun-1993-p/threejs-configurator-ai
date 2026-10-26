# 22: Docker 운영과 모델 예비 전환

**What to build:** 서버가 LAN의 로컬 Docker에서 무료·오픈소스 구성으로 돌고, LiteLLM이 Cerebras, 예비 Groq, 로컬 모델 사이에서 전환되며, 모델을 바꿔도 단계별 입출력 형식은 그대로다(ADR-0015).

**Blocked by:** 15 (LiteLLM 포트와 실제 명세 작성)

**Status:** ready-for-agent

- [ ] 서버 전체가 Docker 구성 하나로 LAN에서 뜬다
- [ ] API 키 등 비밀값은 저장소 밖 환경 파일로 주입된다
- [ ] LiteLLM 설정만 바꿔 Cerebras, Groq, 로컬 모델(운영체제·기종 무관)로 전환된다
- [ ] 외부 API가 응답하지 않으면 예비 모델로 넘어간다
- [ ] 모델을 바꿔도 같은 녹화본으로 경계 1 테스트가 통과한다
