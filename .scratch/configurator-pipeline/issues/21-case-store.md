# 21: 사례 저장소

**What to build:** 최종 승인된 상품의 결정 기록이 사례 저장소에 쌓이고, 다음 상품의 후보 제시·명세 작성·AI 판정에 같은 상품 종류로 거른 임베딩 유사도 상위 3개가 예시로 들어간다. 학습은 하지 않는다(ADR-0011).

**Blocked by:** 16 (정보 입력, 후보 제시·선택), 19 (AI 판정), 20 (최종 승인 편집과 반려)

**Status:** ready-for-agent

- [x] 승인되면 상품 종류, 정보 입력, 제시된 후보 전부와 선택된 후보, 최종 명세, 최종 승인 때 고친 내용, 거절 이유가 JSONL 사례로 기록된다
- [x] 사례가 LanceDB에 임베딩으로 색인된다
- [x] 후보 제시·명세 작성·AI 판정에 같은 상품 종류의 유사도 상위 3개가 예시로 들어간다
- [x] 사례를 빼면 다음 상품부터 예시에 나오지 않는다
- [x] 사례 기록 파일은 공개 저장소에 올라가지 않는다

## Comments

### 2026-11-02 구현

- **사례 기록**: `CaseRecord`가 상품 종류, 정보 입력, 회차마다 제시된 후보(`candidates: Candidate[][]`), 고른 후보(`chosen`, 축 대응과 부모 포함), 고친 내용을 넣은 최종 명세, 고친 내용(`edits`), 거절 이유(`rejections`), "다른 후보"로 반려한 고른 후보(`backToChoice`)를 담는다. 거절 기록의 후보 타입을 실제로 넣던 고른 후보(`ChosenCandidate`)로 바로잡았다.
- **저장소 포트**: `StorePort.recordCase` 대신 `cases: CaseStore`(`record`·`similar`·`list`·`remove`, `pipeline/case-store.ts`). 메모리 구현(`memoryCaseStore`, 시험·개발용)과 JSONL+LanceDB 구현(`lanceCaseStore`)이 있다.
- **예시 주입**: 정보 입력 검사 뒤 상품마다 한 번 같은 상품 종류에서 정보 입력(상품 종류·상품명·메모, `caseQuery`)의 임베딩 유사도 상위 3개(`CASE_EXAMPLES`)를 꺼내 후보 제시·명세 작성·AI 판정 입력 `examples`로 넣는다. LiteLLM 지시문 세 곳에 그 쓰임을 적었다.
- **색인**: JSONL이 원본이고 LanceDB 색인은 검색할 때마다 기록에 맞춘다. 빠진 사례·정보 입력을 고친 사례는 지우고, 없는 것만 임베딩하고, 벡터 길이가 바뀌면(임베딩 모델 교체) 다시 만든다. 읽을 수 없는 줄은 줄 번호와 함께 실패한다.
- **임베딩**: `liteLlmEmbed`(LiteLLM `/v1/embeddings`). 수동 실행 도구는 `LITELLM_EMBED_MODEL`(기본 `embedding`)과 `CASES_DIR`(기본 `data/cases`)를 쓴다. 티켓 22의 LiteLLM 설정에 `embedding` 모델 이름이 있어야 한다. 시험은 외부 모델 없이 글자 두 개 묶음 임베딩(`ngramEmbedding`)을 쓴다.
- **사례 빼기**: `node scripts/cases.ts list|remove <id>`, 또는 `cases.jsonl`에서 줄을 지운다.
- **공개 저장소**: 기본 폴더 `data/cases/`는 `.gitignore`의 `data/`라 올라가지 않는다. 시험이 `git check-ignore`로 확인한다.
- 의존성: `@lancedb/lancedb` 0.41.0, `apache-arrow` 21.1.0(피어 의존성). Windows x64에서 동작을 확인했다.
- 시험: `pipeline.test.ts` 4개(기록 내용, 회차·거절 이유·고친 내용, 상위 3개 주입, 다음 상품부터 반영과 빼기), `case-store.test.ts` 8개, `litellm-ai.test.ts` 2개.

### 리뷰 뒤 반영과 남긴 것

- 반영:
  - 색인 줄의 `kind`를 `ProductKind`로 썼다.
  - `caseQuery` 주석을 고치고 `Intake`로 받는다.
  - 저장소 포트가 `recordCase`·`similarCases`로 그대로 넘기던 것을 없애고 `cases: CaseStore` 하나로 둔다.
  - 시험의 `pastCase`를 `test/cases.ts` 하나로 모았다.
  - 실행기 `submit`이 사례에 들어갈 결정(고친 내용 포함)을 한 묶음으로 받는다.
  - 색인의 id가 기록에 늘 있는 까닭을 주석으로 남겼다.
  - GLOSSARY에 "사례 기록"을 올렸다.
  - 임베딩 모델 교체, 손으로 고친 정보 입력, 깨진 줄을 다룬다(위 "색인").
  - "다른 후보"로 반려한 후보를 `backToChoice`로 남긴다.
- 남긴 것:
  - **유사도가 같을 때 순서**: 메모리 구현은 먼저 기록된 사례가 앞서지만 LanceDB는 보장하지 않는다. 같은 점수는 정보 입력 문장이 같다는 뜻이라 어느 쪽이 먼저 와도 예시의 쓸모는 같다.
  - **예시가 AI 입력을 키운다**: 사례마다 명세와 모든 회차의 후보가 들어간다. 사례는 3개이고 그림이 없어 지금은 줄이지 않는다. 티켓 23 최종 확인에서 토큰 한도에 걸리면 단계별로 필요한 필드만 남긴다.
  - **LanceDB 도입 ADR**: 명세와 ADR-0011 문맥, `docs/plan.md`가 이미 LanceDB를 정해 두었고, 색인은 JSONL에서 다시 만들 수 있어 되돌리기 어려운 결정이 아니다.
