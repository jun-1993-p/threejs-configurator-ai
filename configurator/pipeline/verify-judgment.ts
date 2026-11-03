// AI 판정: 수치로 잡을 수 없는 뚫림·겹침·비례 깨짐을 VLM이 렌더링을 보고 찾는다(사용자 스토리 61).
// 렌더링은 결과물에 담긴 스윕 데이터로 만들어, 고객이 구성기에서 볼 형상을 그대로 보게 한다.
import { createMorph, placeOf, type Spec, type SweepData } from "../src/engine.ts";
import { obliqueView, partColorsOf, type PartColor } from "./candidate-cards.ts";
import type { Feedback } from "./feedback.ts";
import { partPalette, renderPngs } from "./render.ts";
import type { Front } from "./schemas.ts";

/** AI 판정에 보내는 그림 하나: 슬라이더 값 묶음(values)에서 그린 형상(PNG, base64). name은 바뀐 슬라이더만 적은 자리 표기다. */
export interface JudgmentRender {
  name: string;
  values: Record<string, number>;
  image: string;
}

/** 렌더링 하나와 피드백이 가리킬 슬라이더: 슬라이더 끝값이면 그 슬라이더, 모서리 조합이면 앞 슬라이더 */
export interface JudgmentShot {
  slider: string;
  render: JudgmentRender;
}

/** ai_judgment 피드백의 measured: 저장한 렌더링 경로, 그 슬라이더 값, 판정 이유 한 줄 */
export interface JudgmentMeasured {
  image: string;
  values: Record<string, number>;
  reason: string;
}

/** AI 판정이 렌더링 하나에서 찾은 문제와 그 이유 한 줄 */
export interface JudgmentProblem {
  image: string;
  reason: string;
}

const RENDER_SIZE = { width: 320, height: 240 };

/**
 * 슬라이더마다 min·max, 그다음 슬라이더 쌍마다 모서리 조합 4개(앞 슬라이더가 바깥 고리)의 렌더링. 나머지 슬라이더는 default다.
 * 모두 같은 축척이라 끝값끼리 크기 차이가 그대로 보인다. 그림은 정면에서 오른쪽 위로 비켜 본 것이다.
 */
export function judgmentShots(spec: Spec, sweeps: SweepData): { shots: JudgmentShot[]; colors: PartColor[] } {
  const defaults = Object.fromEntries(spec.sliders.map((s) => [s.id, s.default]));
  const places: { slider: string; place: Record<string, number> }[] = [];
  for (const s of spec.sliders) for (const v of [s.min, s.max]) places.push({ slider: s.id, place: { [s.id]: v } });
  spec.sliders.forEach((a, i) => {
    for (const b of spec.sliders.slice(i + 1)) {
      for (const va of [a.min, a.max]) for (const vb of [b.min, b.max]) places.push({ slider: a.id, place: { [a.id]: va, [b.id]: vb } });
    }
  });

  const morph = createMorph(spec, sweeps);
  // 명세의 front와 axes는 명세 검사를 통과한 값이다
  const view = obliqueView(spec.front as Front, `+${spec.axes.H}` as Front);
  const colorOf = partPalette(sweeps.parts.map((p) => p.name));
  const values = places.map(({ place }) => ({ ...defaults, ...place }));
  const images = renderPngs(values.map((v) => morph.shape(v)), view, RENDER_SIZE, colorOf);
  const shots = places.map(({ slider, place }, k) => ({ slider, render: { name: placeOf(place), values: values[k], image: images[k].toString("base64") } }));
  return { shots, colors: partColorsOf(morph.faces.map((f) => f.part), colorOf) };
}

/**
 * 판정이 찾은 문제 하나의 검증 피드백. 슬라이더 끝값이면 그 슬라이더를, 모서리 조합이면 앞 슬라이더를 가리킨다.
 * image는 저장한 그 렌더링의 경로다. 부품은 판정이 짚지 않으므로 빈 문자열이다.
 */
export function judgmentFeedback(spec: Spec, { slider, render }: JudgmentShot, reason: string, image: string): Feedback {
  const measured: JudgmentMeasured = { image, values: render.values, reason };
  return {
    path: `sliders[${spec.sliders.findIndex((s) => s.id === slider)}]`,
    slider,
    part: "",
    kind: "ai_judgment",
    measured,
    expected: "뚫림·겹침·비례 깨짐 없음",
    hint: `${render.name}에서 AI 판정이 짚음: 렌더링을 보고 문제가 맞으면 그 끝값을 범위에서 빼거나 반려`,
  };
}
