// 범위 교집합: 슬라이더 범위는 치수 규칙 ∩ 정보 입력 메모 ∩ 스윕 범위 안에서 정하고, 근거가 된 치수 규칙을 source에 남긴다(ADR-0009).
// 스윕 범위가 애드인이 줄인 쪽은 범위 검증(verify-range.ts)이 줄어든 까닭과 함께 알리므로 여기서는 보지 않는다.
import type { Axis, Slider, Spec } from "../src/engine.ts";
import type { Feedback } from "./feedback.ts";
import type { UploadBundle } from "./upload-bundle.ts";

/** 치수 규칙 하나: 상품 종류의 한 부위(폭·깊이·서랍 깊이 등)의 인체공학적 범위와 그 출처 */
export interface DimensionRule {
  /** 명세의 source가 가리키는 이름(치수규칙/서랍장/폭) */
  id: string;
  /** 상품 종류. 정보 입력의 상품 종류와 같은 말이다. */
  kind: string;
  /** 부위. 정보 입력 메모의 범위는 이 이름으로 찾는다. */
  part: string;
  /** 부위가 놓인 축. source로 고른 규칙은 슬라이더와 같은 축이어야 한다. */
  axis: Axis;
  min: number;
  max: number;
  /** 범위의 출처(문헌·표준) */
  origin: string;
}

interface Range {
  min: number;
  max: number;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 메모의 "값~값". 값은 쉼표 천 단위를 써도 되고, 단위(mm·cm)는 한쪽에만 붙어도 양쪽에 쓴다. */
const VALUE = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(mm|cm)?`;
const RANGE = String.raw`${VALUE}\s*[~\-–〜～]\s*${VALUE}`;
/** 부위 이름과 범위 사이에 올 수 있는 조사와 쌍점 */
const JOINER = String.raw`\s*(?:은|는|이|가|:|：)?\s*`;

const toMm = (value: string, unit: string | undefined) => Number(value.replaceAll(",", "")) * (unit === "cm" ? 10 : 1);

/**
 * 정보 입력 메모에서 부위별 범위를 읽는다. "폭 600~1200", "폭은 60~120cm", "폭: 600mm ~ 1,200mm"처럼
 * 부위 이름 바로 뒤에 "값~값"이 오는 것만 범위로 본다. 부위 이름은 그 상품 종류의 치수 규칙에서 가져오고,
 * 긴 이름부터 찾아 "서랍 폭 300~500"이 "폭"으로 잡히지 않게 한다. 이름 안의 띄어쓰기는 없어도 된다("서랍깊이").
 * 어느 부위에도 붙지 않은 "값~값"은 unread로 돌려준다(운영자가 의도를 확인하게).
 */
function memoRanges(memo: string, parts: string[]): { ranges: Map<string, Range>; unread: string[] } {
  const ranges = new Map<string, Range>();
  let rest = memo;
  for (const part of [...new Set(parts)].sort((a, b) => b.length - a.length)) {
    const name = part.split(/\s+/).map(escapeRegExp).join("\\s*");
    const pattern = new RegExp(String.raw`(?<![\p{L}\p{N}_])${name}${JOINER}${RANGE}`, "gu");
    rest = rest.replace(pattern, (match, a: string, unitA: string | undefined, b: string, unitB: string | undefined) => {
      const [from, to] = [toMm(a, unitA ?? unitB), toMm(b, unitB ?? unitA)];
      if (!ranges.has(part)) ranges.set(part, { min: Math.min(from, to), max: Math.max(from, to) });
      return " ".repeat(match.length);
    });
  }
  const unread = [...rest.matchAll(new RegExp(RANGE, "gu"))].map((m) => m[0].trim());
  return { ranges, unread };
}

/** 슬라이더 하나의 세 범위와 업로드한 모델의 값. 메모에 그 부위의 범위가 없으면 memo가 없다. */
interface Bounds {
  rule: DimensionRule;
  memo?: Range;
  sweep: Range & { reduced: { min: boolean; max: boolean } };
  model: number;
}

const span = ({ min, max }: Range) => `${min}~${max}`;

/** 교집합의 근거를 사람이 읽는 말로. 애드인이 줄인 쪽 스윕 범위는 그렇다고 적는다. */
function boundsText({ rule, memo, sweep }: Bounds): string {
  const reduced = (["min", "max"] as const).filter((side) => sweep.reduced[side]);
  return [
    `치수 규칙 ${rule.id} ${span(rule)}`,
    ...(memo ? [`정보 입력 메모 ${rule.part} ${span(memo)}`] : []),
    `스윕 범위 ${span(sweep)}${reduced.length > 0 ? `(${reduced.join("·")} 쪽은 애드인이 줄임)` : ""}`,
  ].join(", ");
}

const intersect = (ranges: Range[]): Range => ({ min: Math.max(...ranges.map((r) => r.min)), max: Math.min(...ranges.map((r) => r.max)) });

/** 세 범위의 교집합. ignoreReduced면 애드인이 줄인 쪽 스윕 범위는 빼고 본다. */
function intersectBounds({ rule, memo, sweep }: Bounds, ignoreReduced = false): Range {
  const sweepRange = {
    min: ignoreReduced && sweep.reduced.min ? -Infinity : sweep.min,
    max: ignoreReduced && sweep.reduced.max ? Infinity : sweep.max,
  };
  return intersect([rule, ...(memo ? [memo] : []), sweepRange]);
}

/** 세 범위의 교집합. 비었거나 업로드한 모델의 값(기본값)을 담지 않으면 슬라이더 범위를 정할 수 없다. */
function intersection(bounds: Bounds): { range: Range; usable: boolean } {
  const range = intersectBounds(bounds);
  return { range, usable: range.min <= bounds.model && bounds.model <= range.max };
}

export interface RangeContext {
  /** 정보 입력의 상품 종류로 거른 치수 규칙 */
  rules: DimensionRule[];
  intake: { kind: string; memo: string };
  bundle: Pick<UploadBundle, "sweeps" | "parameters">;
}

/** 업로드한 모델의 그 파라미터 값 */
const modelValue = (bundle: RangeContext["bundle"], id: string) => bundle.parameters.find((p) => p.name === id)?.value;

/** 슬라이더마다 세 범위(memo는 읽어 둔 메모의 부위별 범위). source가 치수 규칙에 없거나 스윕하지 않은 파라미터면 undefined다(다른 검사가 알린다). */
function sliderBounds({ rules, bundle }: RangeContext, memo: Map<string, Range>) {
  return (slider: Slider): Bounds | undefined => {
    const rule = rules.find((r) => r.id === slider.source);
    const sweep = bundle.sweeps.find((s) => s.parameter === slider.id);
    const model = modelValue(bundle, slider.id);
    if (!rule || !sweep || model === undefined) return undefined;
    const reduced = { min: false, max: false };
    for (const r of sweep.reductions ?? []) reduced[r.side] = true;
    return { rule, memo: memo.get(rule.part), sweep: { ...sweep.range, reduced }, model };
  };
}

/**
 * 범위 교집합 검사 두 가지와, 메모에서 어느 부위에도 붙지 않아 읽지 못한 범위(unreadMemo).
 * 메모는 상품 하나를 처리하는 동안 바뀌지 않으므로 한 번만 읽는다.
 * - check(명세 검사): source가 그 상품 종류의 치수 규칙에 있고 슬라이더와 같은 축이며, 기본값이 업로드한 모델의 값이며, 슬라이더 범위가 교집합 안인지.
 *   교집합이 비면 범위를 고칠 수 없으므로 넘기고 noIntersection이 알린다.
 * - noIntersection: 교집합이 비었거나 업로드한 모델의 값을 담지 않는 슬라이더마다 범위 교집합 없음 피드백.
 */
export function rangeIntersection(context: RangeContext) {
  const ids = new Set(context.rules.map((r) => r.id));
  const memo = memoRanges(context.intake.memo, context.rules.map((r) => r.part));
  const boundsOf = sliderBounds(context, memo.ranges);

  function rangeErrors(slider: Slider, i: number): string[] {
    if (!ids.has(slider.source)) return [`/sliders/${i}/source: ${context.intake.kind}의 치수 규칙에 없는 이름(${slider.source})입니다`];
    const rule = context.rules.find((r) => r.id === slider.source)!;
    // 다른 축 부위의 규칙을 붙이면 메모의 범위를 비켜 갈 수 있다
    if (rule.axis !== slider.axis) return [`/sliders/${i}/source: ${rule.id}의 축(${rule.axis})이 슬라이더 축(${slider.axis})과 다릅니다`];
    const bounds = boundsOf(slider);
    if (!bounds || !intersection(bounds).usable) return [];
    // 줄어든 쪽 스윕 범위는 범위 검증이 그 까닭과 함께 알린다
    const allowed = intersectBounds(bounds, true);
    const outside = [...(slider.min < allowed.min ? (["min"] as const) : []), ...(slider.max > allowed.max ? (["max"] as const) : [])];
    return outside.map((side) => `/sliders/${i}/${side}: 범위 교집합 ${span(allowed)} 밖의 값(${slider[side]})입니다(${boundsText(bounds)})`);
  }

  return {
    unreadMemo: memo.unread,
    check: (spec: Pick<Spec, "sliders">): string[] =>
      spec.sliders.flatMap((slider, i) => [...defaultErrors(slider, i, context), ...rangeErrors(slider, i)]),
    noIntersection: (spec: Pick<Spec, "sliders">): Feedback[] =>
      spec.sliders.flatMap((slider, i) => {
        const bounds = boundsOf(slider);
        return bounds ? noIntersectionFeedback(slider, i, bounds) : [];
      }),
  };
}

/** 업로드한 모델의 값과 명세의 기본값을 같은 값으로 보는 차이(mm). Fusion 값은 cm에서 바꾼 부동소수다. */
const SAME_VALUE_MM = 1e-6;

/** 기본값은 업로드한 모델의 값이고 슬라이더 범위 안이다. 구성기를 처음 열면 원본 상품 모습이 보여야 한다. */
function defaultErrors(slider: Slider, i: number, { bundle }: RangeContext): string[] {
  const model = modelValue(bundle, slider.id);
  if (model === undefined) return [];
  if (Math.abs(slider.default - model) > SAME_VALUE_MM) return [`/sliders/${i}/default: 업로드한 모델의 값(${model})과 다릅니다`];
  if (slider.default < slider.min || slider.default > slider.max) return [`/sliders/${i}/default: 범위(${span(slider)}) 밖의 값(${slider.default})입니다`];
  return [];
}

/**
 * 교집합이 비었거나 업로드한 모델의 값을 담지 않으면 범위 교집합 없음. 범위를 지어내지 않도록 조립·검증 전에 알리고,
 * 처리 기록으로 운영자에게도 보인다. AI가 고칠 수 있는 것은 슬라이더를 빼는 것뿐이고, 메모나 모델은 운영자가 확인한다.
 */
function noIntersectionFeedback(slider: Slider, i: number, bounds: Bounds): Feedback[] {
  const { range, usable } = intersection(bounds);
  if (usable) return [];
  const { rule, memo, sweep, model } = bounds;
  const problem = range.min > range.max ? "겹치지 않습니다" : `겹치는 ${span(range)}에 업로드한 모델의 값(${model})이 없습니다`;
  return [
    {
      path: `sliders[${i}].source`,
      slider: slider.id,
      part: "",
      kind: "no_range_intersection",
      measured: {
        rule: { id: rule.id, min: rule.min, max: rule.max },
        ...(memo ? { memo } : {}),
        sweep: { min: sweep.min, max: sweep.max },
        default: model,
      },
      expected: "세 범위가 겹치고 기본값을 담는 구간",
      hint:
        `${slider.id}의 세 범위(${boundsText(bounds)})가 ${problem}. ` +
        "범위를 지어내거나 다른 부위의 치수 규칙으로 바꾸지 말고 이 슬라이더를 빼세요. 운영자는 정보 입력 메모와 모델을 확인해야 합니다",
    },
  ];
}
