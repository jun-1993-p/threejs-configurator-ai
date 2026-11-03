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

- [ ] 비선형으로 변하는 부분이 있는 모델(티켓 05 적응형 스윕, 재계산 실패 지점의 스윕 범위 축소 포함)
- [ ] 한 축에 슬라이더가 둘인 모델(티켓 06 축 반응 검증)
- [ ] 두 슬라이더가 서로 영향을 주는 모델(티켓 09 격자 보강)
- [ ] 폭에 따라 칸막이 수가 바뀌는 모델(티켓 11 위상 묶음, 합성은 `fixtures/synthetic/shelf.json`)
- [ ] 판재 두께가 수식에 섞인 모델(티켓 13 두께 고정 실측)

### 5. 실제 상품으로 실제 모델 확인 (티켓 15에서 옮김)

- [ ] 실제 상품 하나로 실제 모델을 써서 수치 검증까지 통과하는 수동 확인 기록이 있다. LiteLLM에 Cerebras `gpt-oss-120b`를 걸고 `scripts/run-pipeline.ts`로 돌린다. 기록은 이 티켓 아래에 남긴다

### 6. 실제 키로 예비 모델 전환 확인 (티켓 22에서 옮김)

Docker 구성(`docs/docker.md`)을 띄우고 `.env`에 실제 키를 넣어 확인한다. 어느 모델이 답했는지는 LiteLLM 응답 헤더 `x-litellm-model-group`으로 본다.

- [ ] Cerebras 키로 `llm`·`vlm`이 실제로 답한다(헤더가 `llm`·`vlm`)
- [ ] `docker/litellm/config.yaml`의 Cerebras VLM 이름 `qwen3.8-27b`가 실제 모델 이름이다. 아니면 설정을 고친다
- [ ] Cerebras 키를 비우면 Groq가 답한다(헤더가 `llm-groq`·`vlm-groq`)
- [ ] Cerebras·Groq 키를 모두 비우면 로컬 모델이 답한다(헤더가 `llm-local`·`vlm-local`). 먼저 `docker compose exec ollama ollama pull gpt-oss:20b`와 `qwen3-vl:8b`를 받는다. 티켓 22에서는 받지 않아 `qwen2.5:3b`로만 확인했다
- [ ] 위 확인마다 `scripts/run-pipeline.ts`를 합성 서랍장 녹화본 `fixtures/synthetic/drawer.json`으로 돌려, 모델이 바뀌어도 형식 오류가 다음 단계로 새지 않는지 처리 기록(`log.json`)으로 본다

## Comments

- 2026-11-02: Fusion에 접근할 수 없는 동안 사람 확인이 티켓 01·15·25에 흩어져 있어, 코드가 끝난 티켓 15가 16·18·19·22를 막고 있었다. 사람 확인을 이 티켓으로 모으고 원래 티켓은 코드 완료로 둔다.
- 5절 중 Fusion이 필요 없는 부분(큰 모델로 정면·축까지 맞는 명세가 나오는지)은 Cerebras 키만 있으면 합성 서랍장 녹화본 `fixtures/synthetic/drawer.json`으로 먼저 볼 수 있다. 로컬 7b 모델로는 안정적으로 나오지 않았다(티켓 15 수동 확인 기록).
