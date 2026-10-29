# 06: 축 반응 검증

**What to build:** 명세에 슬라이더마다 형태 변경 부품과 위치 이동 부품을 선언하고, 검증이 단독 스윕에서 실제 축 반응과 비교한다. 한 축에 슬라이더가 여러 개여도(전체 폭·서랍 폭) 각 슬라이더가 맡은 부품만 움직이는지 부품 단위로 확인한다.

**Blocked by:** 04 (수치 검증과 검증 피드백 루프)

**Status:** ready-for-agent

- [x] 명세의 슬라이더에 `affects.shape`, `affects.move`가 있다
- [x] 형태 변경 부품의 해당 축 치수가 바뀌지 않으면 실패한다
- [x] 선언되지 않은 부품이나 위치 이동 부품의 치수가 바뀌면 `unexpected_shape_change`로 실패한다
- [x] 슬라이더의 축이 아닌 다른 축(D·H 등) 치수가 바뀌면 실패한다
- [x] 피드백은 부품 이름과 고칠 명세 위치를 담는다
- [x] 수치 검증을 통과한 뒤에만 축 반응 검증이 돈다
- [x] 한 축에 슬라이더 두 개가 있는 녹화본으로 경계 1 테스트가 있다

## Comments

### 2026-10-29 구현

- 검증기: `configurator/pipeline/verify-axis.ts`의 `verifyAxisResponse(spec, bundle)`. 업로드 묶음의 단독 스윕(Fusion 형상)에서 슬라이더 범위 안의 샘플과 검증점(재계산 성공, 기본값 제외)마다 부품의 W·D·H별 치수와 가운데 위치 변화를 잰다. 부품은 바디 단위로 재서 면 구성이 바뀐 샘플도 잰다(ADR-0006).
- 판정은 규칙 표(`AXIS_RULES`)로 한다. 표는 `docs/spec-schema.md`의 "축 반응" 표와 같다. 형태 변경 부품은 축 치수가 바뀌어야 하고, 위치 이동 부품은 치수는 그대로 자리만 옮겨져야 하며, 선언하지 않은 부품은 그대로여야 한다. 모든 부품은 다른 축의 치수와 위치가 그대로여야 한다(`off_axis_change`, path `sliders[i].axis`).
  - "바뀌었다"의 문턱은 0.2 mm(치수 오차 합격선과 같은 값)다.
  - "바뀌지 않는다"는 범위 안에서 가장 크게 바뀐 샘플도 문턱 이하라는 뜻이다.
- 실패 종류 두 개를 더했다. `missing_axis_change`는 선언한 축 반응이 없는 경우, `unexpected_move`는 선언하지 않은 부품이 옮겨진 경우다. 기존 목록에는 맞는 것이 없었다. `feedback.ts`, `docs/spec-schema.md`, `spec.md`를 고쳤다.
- 실행기: 수치 검증 피드백이 비었을 때만 축 반응을 본다(`writeVerifiedSpec`). 명세 검사(`specReferenceChecker`, `schemas.ts`)가 세 가지를 보고 형식 오류처럼 다시 묻는다. 슬라이더 id에 스윕이 없는 경우, affects에 업로드 묶음에 없는 부품 이름이 있는 경우, 한 부품이 shape와 move에 함께 있는 경우다.
- 측정 도우미(`DIMENSIONS`, `coordinateOf`, `round`, `boundsOf`)는 `pipeline/measure.ts`로 모아 수치 검증기와 같이 쓴다.
- 시험: `test/verify-axis.test.ts`(경계 2)는 깊이 축 슬라이더가 둘인 합성 서랍장 녹화본을 쓴다. 전체 깊이 `body_d`는 몸통과 서랍을 바꾸고, 서랍 깊이 `drawer_d`는 서랍만 바꾼다. 녹화본에는 위치 이동 부품이 없어서, 전체 높이 스윕에서 서랍을 올린 사본(`test/recording.ts`의 `movePart`)을 쓴다. `test/pipeline.test.ts`(경계 1)에는 세 가지를 더했다. 한 축 두 슬라이더 명세의 재시도와 제출, 수치 검증이 먼저 도는지, 명세 이름 검사다.
- 리뷰에서 반영하지 않은 것:
  - `Feedback.measured`를 종류별 타입으로 나누지 않았다. 수치 검증도 `measured`를 자유 형식으로 쓰고, 형식은 `docs/spec-schema.md`가 정한다. 종류별 타입은 모든 검증기를 같이 바꿔야 해서 이 티켓 범위 밖이다.
  - 실행기의 `bundle as UploadBundle` 형변환이 한 군데 늘었다. 원래 있던 패턴(업로드 단계에서 스키마를 통과한 뒤 좁힘)을 따랐다.
