// 교차 검증: 슬라이더 쌍마다 범위 모서리 조합에서 Fusion 형상을 받아, 단독 스윕 이동량을 더한 변형 결과와 비교한다(ADR-0004).
// 합격선과 재는 방법은 수치 검증과 같다(ADR-0012).
import type { SampleFace, Spec, SweepData } from "../src/engine.ts";
import type { Feedback } from "./feedback.ts";
import type { UploadBundle } from "./upload-bundle.ts";
import { shapeComparer, type PartFailure } from "./verify-numeric.ts";

/** 교차 검증 샘플: 여러 파라미터를 함께 바꾼 Fusion 형상(업로드 묶음 스키마의 crossSample) */
export interface CrossSample {
  values: Record<string, number>;
  status: "ok" | "recompute_failed";
  faces: SampleFace[];
}

interface Corner {
  /** 쌍의 두 슬라이더 번호 */
  pair: [number, number];
  /** 모든 슬라이더 값. 쌍은 범위 끝, 나머지는 default */
  values: Record<string, number>;
}

/** 슬라이더 쌍마다 범위 모서리 4곳. 슬라이더가 하나면 없다. */
function corners(spec: Spec): Corner[] {
  const defaults = Object.fromEntries(spec.sliders.map((s) => [s.id, s.default]));
  const out: Corner[] = [];
  spec.sliders.forEach((a, i) => {
    spec.sliders.slice(i + 1).forEach((b, k) => {
      for (const va of [a.min, a.max]) {
        for (const vb of [b.min, b.max]) out.push({ pair: [i, i + 1 + k], values: { ...defaults, [a.id]: va, [b.id]: vb } });
      }
    });
  });
  return out;
}

/** 애드인에 요청할 교차 검증 샘플의 값 묶음. 응답은 같은 순서로 온다. */
export const crossCheckValues = (spec: Spec): Record<string, number>[] => corners(spec).map((c) => c.values);

/**
 * 교차 검증 샘플에서 합격선을 넘은 항목을 검증 피드백으로 돌려준다. 통과하면 빈 목록이다.
 * samples는 crossCheckValues(spec)의 순서대로 받은 Fusion 형상이다.
 * 피드백은 쌍의 앞 슬라이더를 가리키고, measured.values에 쌍의 두 값이 있다.
 */
export function verifyCross(spec: Spec, sweeps: SweepData, bundle: UploadBundle, samples: CrossSample[]): Feedback[] {
  const compare = shapeComparer(spec, sweeps, bundle);
  return corners(spec).flatMap(({ pair: [i, j], values }, n) => {
    const [a, b] = [spec.sliders[i], spec.sliders[j]];
    const pairValues = { [a.id]: values[a.id], [b.id]: values[b.id] };
    const place = `${a.id}=${values[a.id]}·${b.id}=${values[b.id]}`;
    const hintTail = `${a.id}와 ${b.id}를 함께 움직이면 덧셈이 맞지 않습니다. 한쪽을 다른 쪽의 자식으로 두거나 두 범위를 좁히세요`;
    const feedback = (failure: PartFailure): Feedback => ({ path: `sliders[${i}]`, slider: a.id, ...failure });
    const sample = samples[n];

    // 부품과 무관한 실패는 part를 비워 둔다.
    if (sample.status !== "ok") {
      return [feedback({ part: "", kind: "recompute_failed", measured: { values: pairValues }, expected: "재계산 성공", hint: `Fusion이 ${place}에서 재계산하지 못합니다. ${hintTail}` })];
    }
    const failures = compare(values, sample.faces, { measured: { values: pairValues }, place, hintTail });
    if (!failures) {
      return [feedback({ part: "", kind: "topology_change", measured: { values: pairValues }, expected: "기본 형상과 같은 면 구성", hint: `${place}에서 면 구성이 기본 형상과 다릅니다. ${hintTail}` })];
    }
    return failures.map(feedback);
  });
}
