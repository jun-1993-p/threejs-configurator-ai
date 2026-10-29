// 두께 선택(ADR-0010): 애드인에서 받은 두께 후보 형상을 변형 엔진에 넣을 수 있는지 본다.
// 두께 후보 형상은 기준 형상(위상 묶음이면 그 묶음의 기준 형상)에서 두께만 바꾼 형상이라, 면 구성이 같아야 한다.
// 두께와 슬라이더를 함께 바꾼 덧셈 확인(교차 검증)과 두께 고정 실측은 아직 하지 않는다(티켓 13).
import { placeOf, type CrossSample, type ThicknessSample } from "../src/engine.ts";
import type { Feedback } from "./feedback.ts";
import { unusableSample } from "./verify-cross.ts";

/** 두께 후보 형상을 뽑을 수 없을 때 힌트 끝에 붙는 고치는 방법 */
const FIX_THICKNESS = "이 두께 선택을 빼고 고정 두께로 두거나, 모델의 두께 수식을 확인하세요";

/**
 * 받은 두께 후보 형상마다 재계산 실패나 위상 변화가 있으면 그 두께 선택을 가리키는 피드백을 돌려준다.
 * samples는 plan(thicknessSamplePlan)의 순서대로 받은 Fusion 형상이다.
 */
export function checkThicknessSamples(plan: ThicknessSample[], samples: CrossSample[]): Feedback[] {
  return plan.flatMap(({ choice, baseline, values }, n) =>
    unusableSample(samples[n], baseline, { path: `thickness[${choice}].options`, slider: "", part: "", measured: { values } }, placeOf(values), FIX_THICKNESS),
  );
}
