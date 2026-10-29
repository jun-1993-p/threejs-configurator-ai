# 02: 녹화 묶음으로 구성기 띄우기

**What to build:** 손으로 쓴 슬라이더 1개짜리 명세와 녹화된 업로드 묶음을 넣으면, 변형 엔진이 단독 스윕 샘플 사이를 보간하고, 고정 코어가 그 결과를 쇼핑몰에 넣을 div 하나짜리 구성기로 띄운다. 쇼핑몰 고객은 슬라이더를 움직여 형태가 매끄럽게 바뀌는 것을 본다. 변형 엔진은 브라우저와 Node에서 같은 라이브러리로 동작한다(테스트 경계 2).

**Blocked by:** 01 (애드인 업로드와 녹화), 25 (경계 맞춤 격자)

녹화본 대신 합성 녹화본(티켓 24)을 써도 된다.

**Status:** ready-for-agent

- [x] 명세(`docs/spec-schema.md` 구조)와 스윕 데이터, 슬라이더 값을 받아 꼭짓점을 내는 변형 엔진이 있다
- [x] 같은 엔진이 브라우저와 Node 양쪽에서 같은 결과를 낸다
- [x] 샘플 값에서는 엔진 결과가 녹화된 Fusion 형상과 일치한다
- [x] 고정 코어가 명세에서 슬라이더를 읽어 UI를 자동으로 구성하고, 기본값은 명세의 `default`이다
- [x] 결과물이 div 하나와 JS 번들로 나와 빈 HTML 페이지에 붙여 동작한다
- [x] Node에서 도는 엔진 테스트가 녹화본을 입력으로 쓴다

## Comments

### 2026-10-29 구현

- 코드: `configurator/`(TypeScript, Node 24가 `.ts`를 그대로 실행). 변형 엔진 `src/engine.ts`(DOM·three.js 없음), 고정 코어 `src/core.ts`(three.js 0.170), 결과물 만들기 `scripts/build.ts`(esbuild).
- 실행: `cd configurator && npm install && npm test`, 타입 검사 `npm run typecheck`. 결과물: `node scripts/build.ts ../fixtures/synthetic/drawer.spec.json ../fixtures/synthetic/drawer.json dist/drawer`.
- 명세: 손으로 쓴 슬라이더 1개짜리 `fixtures/synthetic/drawer.spec.json`(`body_w` "전체 폭" 400~800, 기본 600). 엔진 입력은 서랍장 합성 녹화본(티켓 24·25).
- **엔진**: 스윕 데이터는 업로드 묶음 형식 그대로다(엔진이 쓰는 부분만). 면은 (바디, 이름)으로 기본 형상과 짝짓고, 값을 감싸는 두 샘플의 이동량을 선형으로 섞는다. 샘플 범위 밖 값은 끝 샘플에 붙인다. `recompute_failed` 샘플은 건너뛰고, 면 구성이 기본 형상과 다른 샘플이 있으면 오류를 낸다(위상 묶음은 티켓 10·11). 슬라이더가 여럿이면 이동량을 더하지만 시험은 티켓 07 몫이다.
- **결과물 계약**: `configurator.js`(상품과 무관한 고정 코어 번들, 전역 `Configurator`로 `mount`·`createMorph`), `spec.json`, `sweeps.json`(명세 슬라이더의 단독 스윕만), `index.html`. 쇼핑몰에는 `<div data-configurator data-spec="spec.json" data-sweeps="sweeps.json"></div>`와 `<script src="configurator.js">` 두 줄을 붙인다. 코어가 JSON을 `fetch`하므로 `file://`에서는 동작하지 않고 http로 서비스해야 한다. 고정 코어를 상품마다 같은 바이트로 두려고 데이터를 번들에 넣지 않았다(ADR-0001, 사용자 스토리 74).
- **브라우저와 Node 같음**: 자동 시험(`test/bundle.test.ts`)은 내보낸 번들을 Node `vm`에서 돌려 Node 엔진과 꼭짓점이 완전히 같은지 본다. 실제 브라우저는 손으로 확인했다. Chrome에서 `index.html`을 http로 열어 서랍장이 정면에서 보이고, 슬라이더 1개("전체 폭", 400~800, 간격 10, 기본 600)가 생기며, 420으로 옮기면 폭이 줄었다. Chrome과 Node에서 `body_w` 400·433.3·777의 꼭짓점 가중합이 소수점 끝자리까지 같았다.
- 부품 색은 임시다(스타일 선택은 티켓 18). 슬라이더 UI는 자동 시험이 없다.
