// 두께 선택과 두께 고정(ADR-0010).
// - 두께 후보 형상: 애드인에서 받은 형상을 변형 엔진에 넣을 수 있는지 본다. 기준 형상(위상 묶음이면 그 묶음의 기준 형상)에서
//   두께만 바꾼 형상이라 면 구성이 같아야 한다.
// - 두께 고정 실측: 슬라이더를 움직이는 동안 판재 두께가 그대로인지 녹화된 Fusion 형상으로 잰다. 명세 검사(고정 두께가
//   슬라이더 자식에 없음)로는 못 보는, 두께가 수식에 비율로 섞인 모델을 잡는다.
// 두께와 슬라이더를 함께 바꾼 덧셈 확인(교차 검증)은 verify-cross.ts가 한다.
import { placeOf, type CrossSample, type Spec, type SweepData, type ThicknessSample } from "../src/engine.ts";
import type { Feedback } from "./feedback.ts";
import { round } from "./measure.ts";
import type { UploadBundle } from "./upload-bundle.ts";
import { unusableSample } from "./verify-cross.ts";
import { DIMENSION_TOLERANCE, panelReader, sliderSweeps, sweepPoint, type PanelReading } from "./verify-numeric.ts";

/** 두께 후보 형상을 뽑을 수 없을 때 힌트 끝에 붙는 고치는 방법 */
const FIX_THICKNESS = "이 두께 선택을 빼고 고정 두께로 두거나, 모델의 두께 수식을 확인하세요";

/** 슬라이더가 판재 두께를 바꿀 때 힌트 끝에 붙는 고치는 방법 */
const FIX_FIXED = "모델에서 두께 수식에 이 슬라이더(또는 그 자식)가 섞여 있는지 확인하거나, 이 슬라이더를 빼세요";

/**
 * 받은 두께 후보 형상마다 재계산 실패나 위상 변화가 있으면 그 두께 선택을 가리키는 피드백을 돌려준다.
 * samples는 plan(thicknessSamplePlan)의 순서대로 받은 Fusion 형상이다.
 */
export function checkThicknessSamples(plan: ThicknessSample[], samples: CrossSample[]): Feedback[] {
  return plan.flatMap(({ choice, baseline, values }, n) =>
    unusableSample(samples[n], baseline, { path: `thickness[${choice}].options`, slider: "", part: "", measured: { values } }, placeOf(values), FIX_THICKNESS),
  );
}

/** 슬라이더 하나의 두께 실측 한 곳: 판 하나의 두께와, 그 자리를 피드백에 쓰는 말 */
type Reading = PanelReading & { measured: { value: number } | { values: Record<string, number> }; place: string };

/**
 * 두께 고정 실측: 슬라이더마다 단독 스윕 전체(샘플과 검증점, 위상 묶음이 있으면 묶음 안 단독 스윕도)에서, 판재 두께가
 * 위상 묶음 기준 형상에서 DIMENSION_TOLERANCE보다 많이 바뀐 부품을 슬라이더·부품마다 하나씩 알린다(가장 크게 바뀐 곳).
 * 재계산 실패와 면 구성이 다른 형상(슬라이더 범위가 닿지 않는 위상 묶음 포함)은 재지 않는다.
 */
export function verifyThicknessFixed(spec: Spec, sweeps: SweepData, bundle: UploadBundle): Feedback[] {
  const read = panelReader(spec, sweeps, bundle);
  const readings = spec.sliders.map((): Reading[] => []);
  for (const { i, sweep, fixed } of sliderSweeps(spec, bundle)) {
    for (const { value, status, faces } of [...sweep.samples, ...sweep.checks]) {
      if (status !== "ok") continue;
      const { values, measured, place } = sweepPoint(spec.sliders[i].id, value, fixed);
      for (const panel of read(values, faces) ?? []) readings[i].push({ measured, place, ...panel });
    }
  }

  return readings.flatMap((list, i) => {
    const slider = spec.sliders[i];
    const worst = new Map<string, Reading>();
    for (const r of list) {
      const w = worst.get(r.part);
      if (!w || Math.abs(r.fusionMm - r.baseMm) > Math.abs(w.fusionMm - w.baseMm)) worst.set(r.part, r);
    }
    return [...worst.values()].flatMap(({ measured, place, part, faces, baseMm, fusionMm }): Feedback[] => {
      const change = Math.abs(fusionMm - baseMm);
      if (change <= DIMENSION_TOLERANCE) return [];
      return [
        {
          path: `sliders[${i}]`,
          slider: slider.id,
          part,
          kind: "thickness_change",
          measured: { ...measured, faces, baseline_mm: round(baseMm), fusion_mm: round(fusionMm), change_mm: round(change) },
          expected: { max_change_mm: DIMENSION_TOLERANCE },
          hint: `슬라이더 ${slider.id}가 부품 ${part}의 두께를 바꿉니다: 판 두께(${faces.join("·")})가 ${place}에서 ${round(baseMm)} mm → ${round(fusionMm)} mm. ${FIX_FIXED}`,
        },
      ];
    });
  });
}
