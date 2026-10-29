# 03: 파이프라인 실행기 관통

**What to build:** 상품 하나를 업로드 묶음과 정보 입력, 사람 결정 각본으로 넣으면, 10단계가 코드에 고정된 순서로 진행되어 구성기 결과물이 제출된다(ADR-0014). 이 단계의 AI는 각본대로 답하는 가짜이고, 최종 승인은 승인만 지원한다. 바깥 의존은 Fusion 연결·AI 모델·저장소 세 포트로만 접근한다(테스트 경계 1).

**Blocked by:** 02 (녹화 묶음으로 구성기 띄우기)

**Status:** ready-for-agent

- [x] 실행기가 업로드 → 정보 입력 → 후보 제시 → 후보 선택 → UI 스타일 → 명세 작성 → 조립 → 검증 → 최종 승인 → 제출·기록 순서로만 진행한다
- [x] AI 모델 포트를 각본 가짜로 바꿔 끼울 수 있고, 저장소 포트는 메모리 구현으로 바꿔 끼울 수 있다
- [x] 명세가 JSON Schema 검사를 통과하지 못하면 조립으로 가지 않는다
- [x] 최종 승인에서 승인하면 고정 코어·명세·스윕 데이터로 된 결과물이 제출된다
- [x] 상품 하나의 단계 전이가 처리 기록으로 남는다
- [x] 녹화본 하나로 업로드부터 제출까지 도는 경계 1 테스트가 있다

## Comments

### 2026-10-29 구현

- 코드: `configurator/pipeline/`(TypeScript). 실행기 `runner.ts`의 `runPipeline({ bundle, intake, human, ports: { fusion, ai, store } })`, 각본 가짜 AI `scripted-ai.ts`, 메모리 저장소 `memory-store.ts`, 스키마 검사 `schemas.ts`(Ajv 8.17.1).
- **TypeScript로 둔 이유**: 조립(`scripts/build.ts`)과 검증기가 변형 엔진을 직접 불러야 해서(구성기와 같은 라이브러리) 엔진과 같은 패키지에 두었다. 업로드 수신은 그대로 Python 서버(`server/`)가 맡는다. LiteLLM은 OpenAI 호환 HTTP로 부를 수 있으므로 AI 모델 포트 구현(티켓 15)도 TS에서 가능하다.
- 명세 JSON Schema는 `schema/spec.schema.json`(업로드 묶음 스키마와 같은 자리, 서버와 공유 가능). 업로드 단계에서 업로드 묶음 스키마도 다시 검사한다.
- 모든 AI 응답(후보, UI 스타일, 명세)을 JSON Schema로 검사한다. 틀리면 `schemaErrors`를 붙여 3번까지 다시 묻고, 그래도 틀리면 그 단계에서 `stopped`로 끝난다(조립하지 않음). 후보는 2~4개, 스타일은 저장소 목록 안의 id만 통과한다. 형식 오류는 검증 피드백(`kind` 목록)과 따로 다룬다.
- 처리 기록은 저장소 포트의 `appendLog`로 단계마다 `{ stage, at, detail }`가 남는다.
- 조립은 `assembleProduct`가 메모리에서 결과물 파일 4개(`configurator.js`, `spec.json`, `sweeps.json`, `index.html`)를 만든다. `writeProduct`는 이를 디스크에 쓴다.
- 아직 없는 것: 검증 단계는 빈 자리(수치 04, 축 반응 06, AI 판정 19)라 피드백 루프와 3회 제한은 04에서 붙는다. Fusion 연결 포트는 인터페이스(`requestSamples`)만 있고 부르지 않는다. 최종 승인은 승인만, 사례 기록은 메모리에 담기만 한다(21). 스타일은 고르기만 하고 결과물에는 아직 반영하지 않는다(18).
- 시험: `configurator/test/pipeline.test.ts`(경계 1, 서랍장 합성 녹화본). `cd configurator && npm test`.
- 리뷰 뒤 반영: 처리 기록 항목마다 상품명(`product`)을 남긴다. 명세의 `product`가 정보 입력의 상품명과 다르면 형식 오류로 다시 묻는다.
- 리뷰에서 남긴 판단: 형식 오류 다시 묻기는 사용자 스토리 81(모든 AI 응답의 JSON Schema 검사)을 단계마다 같은 방식으로 적용한 것이다. 횟수(3번 넘게면 멈춤)와 `stopped` 종료는 티켓 04·15에서 바꿀 수 있다. `assembleProduct`는 아직 `scripts/build.ts`에 있으며, 검증기가 붙을 때(04) 모듈 위치를 다시 본다.
