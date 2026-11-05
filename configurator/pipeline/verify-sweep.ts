// 업로드 때 운영자에게 알리는 단독 스윕의 문제: 보간 실패(ADR-0007)와 부피 튐 경고.
// 보간 실패한 파라미터는 슬라이더 후보에서 빠진다(schemas.ts의 candidateReferenceChecker). 부피 튐은 실패로 치지 않는다.
import type { Feedback } from "./feedback.ts";
import { round } from "./measure.ts";
import { SAMPLE_LIMIT } from "./parameter-relations.ts";
import { partOfBody, scopes, whereOf, type Scope } from "./sweep-scopes.ts";
import type { InterpolationFailure, UploadBundle } from "./upload-bundle.ts";

/** 샘플 부피가 이웃 샘플로 보간한 부피에서 이 비율보다 더 벗어나면 부피 튐이다. 판 크기가 두 치수에 따라 바뀌어도
 * (부피가 파라미터의 제곱) 5점 스윕의 가운데 샘플이 11%쯤 벗어나므로 그보다 넉넉히 둔다. */
export const VOLUME_JUMP = 0.2;

const ERROR_NAMES: Record<InterpolationFailure["kind"], string> = { shape_error: "형상 오차", dimension_error: "치수 오차" };

function interpolationFeedback(scope: Scope): Feedback[] {
  const failure = scope.sweep.interpolation_failure;
  if (!failure) return [];
  const { at, kind, part, error, tolerance } = failure;
  return [
    {
      path: "",
      slider: scope.sweep.parameter,
      part,
      kind,
      measured: { at, error: round(error) },
      expected: { max_error_mm: tolerance },
      hint:
        `${whereOf(scope)}${scope.sweep.parameter}는 적응형 스윕을 ${SAMPLE_LIMIT}점까지 늘려도 ${at}에서 ${ERROR_NAMES[kind]} ${round(error)} mm가 ` +
        `합격선 ${tolerance} mm를 넘습니다(보간 실패). 이 파라미터는 슬라이더 후보에서 뺍니다`,
    },
  ];
}

/**
 * 같은 위상 묶음 안에서 이웃한 세 샘플마다, 가운데 샘플의 바디 부피를 양옆 샘플로 선형 보간한 값과 견준다.
 * 기본 묶음의 단독 스윕은 샘플 값이 든 위상 묶음(scope.groups, 어디에도 들지 않으면 기본 묶음)으로 나눠 본다. 바디 측정값이 없는 녹화본(티켓 26 4절 전의 Fusion 녹화본)에서는 아무것도 내지 않는다.
 */
function volumeFeedback(scope: Scope): Feedback[] {
  const { groups } = scope;
  const groupOf = (value: number) => groups.findIndex((g) => g.min <= value && value <= g.max);
  const samples = scope.sweep.samples.filter((s) => s.status === "ok" && s.bodies).sort((a, b) => a.value - b.value);
  const out: Feedback[] = [];
  for (let k = 1; k + 1 < samples.length; k++) {
    const [lo, mid, hi] = [samples[k - 1], samples[k], samples[k + 1]];
    if (new Set([lo, mid, hi].map((s) => groupOf(s.value))).size !== 1) continue;
    const t = (mid.value - lo.value) / (hi.value - lo.value);
    for (const body of mid.bodies!) {
      const a = lo.bodies!.find((b) => b.name === body.name);
      const b = hi.bodies!.find((b) => b.name === body.name);
      if (!a || !b) continue;
      const expected = a.volume + (b.volume - a.volume) * t;
      // 보간 부피가 0이면 0으로 나누지 않는다(둘 다 0이면 튀지 않았다)
      const ratio = (body.volume - expected) / Math.max(Math.abs(expected), Number.EPSILON);
      if (Math.abs(ratio) <= VOLUME_JUMP) continue;
      out.push({
        path: "",
        slider: scope.sweep.parameter,
        part: partOfBody(scope, body.name),
        kind: "volume_jump",
        measured: { value: mid.value, body: body.name, volume: Math.round(body.volume) },
        expected: { volume: Math.round(expected) },
        hint:
          `${whereOf(scope)}${scope.sweep.parameter}=${mid.value}에서 바디 ${body.name}의 부피가 이웃 샘플(${lo.value}, ${hi.value})로 보간한 값보다 ` +
          `${Math.round(Math.abs(ratio) * 100)}% ${ratio > 0 ? "큽니다" : "작습니다"}. 실패로 치지 않는 경고입니다. ` +
          `그 값 근처에서 구멍·필렛 같은 형상이 갑자기 생기거나 사라지지 않는지 모델을 확인하세요`,
      });
    }
  }
  return out;
}

/** 업로드 때 운영자에게 알릴 보간 실패와 부피 튐 */
export function uploadSweepFeedback(bundle: UploadBundle): Feedback[] {
  return scopes(bundle).flatMap((scope) => [...interpolationFeedback(scope), ...volumeFeedback(scope)]);
}
