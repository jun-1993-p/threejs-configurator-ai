# 32: 실제 녹화본으로 검증 단계를 돌리는 도구

**What to build:** 실제 Fusion 녹화본에 명세를 붙여, AI 없이 파이프라인의 검증 단계를 실제 애드인의 추가 샘플로 돌리는 도구를 만든다. 티켓 26 선반 실물 확인에서 이 일을 scratchpad 스크립트 여섯 개로 여러 번 고쳐 썼다. 그 스크립트는 실행기(`configurator/pipeline/runner.ts`)의 `assembleAndVerify` 순서를 베껴 써서, 실행기가 바뀌면 어긋난다. 티켓 26의 남은 항목(비선형 모델, 5절 실제 상품)에서 같은 일이 다시 필요하다.

- 실행기에서 AI 없는 검증 순서(두께 후보 형상 → 조립 → 범위 → 두께 고정 실측 → 수치 → 축 반응 → 교차 검증 → 실패한 쌍의 격자 보강과 격자 검증점)를 함수 하나로 꺼낸다. 실행기와 도구가 그 함수를 함께 부른다.
- 명세를 쓰기 전에 슬라이더별 부품 반응(`sweepResponse`)을 보는 쪽도 같은 도구가 맡는다. 명세의 `affects`를 정하는 근거다.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 실행기의 검증 순서를 AI·사람 포트 없이 부를 수 있는 함수로 꺼내고, 실행기는 그 함수를 부른다. 기존 실행기 시험이 그대로 통과한다
- [ ] `configurator/scripts/verify-recording.ts <녹화본> <명세> --upload <업로드 ID>`가 실제 애드인(`httpFusion`)에 추가 샘플을 요청해 단계마다 피드백을 한 줄씩(슬라이더, 부품, 종류, 잰 값) 찍는다. 첫 실패 단계에서 멈추지 않고 모든 단계를 본다(실물 확인은 실패를 모으는 일이라서다)
- [ ] `--responses`를 주면 명세 없이 녹화본만으로 슬라이더별 부품 반응(치수·위치 변화, 축별)을 찍는다
- [ ] 애드인이 연결되지 않았으면 기다리지 않고 "Fusion 연결 필요"와 함께 끝낸다(업로드 완료 창이 열려 있으면 연결이 끊긴다). 티켓 33의 상태 파일(`data/addin-checks/serving.json`)이 있으면 그 내용도 함께 찍는다. 없으면 이 항목은 연결 필요만 알린다
- [ ] 합성 녹화본과 가짜 Fusion 포트로 도구를 시험한다
- [ ] `docs/recording-guide.md`에서 실물 확인 절차가 이 도구를 가리킨다

## Comments

- 2026-11-05: 티켓 26 선반 회고 3번에서 만들었다. scratchpad에 쓴 스크립트 여섯 개: 검증 단계를 돌린 `run_samples.ts`·`run_verify.ts`·`numeric_full.ts`, 부품 반응을 본 `responses.ts`, 애드인 형상을 직접 견준 `probe_box.ts`·`probe_cross.ts`.
