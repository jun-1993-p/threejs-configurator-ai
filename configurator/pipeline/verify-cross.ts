// 교차 검증: 슬라이더 쌍마다 범위 모서리 조합에서 Fusion 형상을 받아, 단독 스윕 이동량을 더한 변형 결과와 비교한다(ADR-0004).
// 두께 선택이 있으면 두께 후보마다 각 슬라이더의 범위 끝에서도 같은 방법으로 본다(ADR-0010). 이 쌍은 [두께 선택의 첫 파라미터, 슬라이더]다.
// 덧셈이 틀리는 쌍은 3×3 격자로 보강하고, 격자 마디 사이의 검증점에서 격자 보간을 확인한다(ADR-0008).
// 합격선과 재는 방법은 수치 검증과 같다(ADR-0012).
import {
  faceKey,
  findPair,
  nonDefaultOptions,
  placeOf,
  samePair,
  thicknessValues,
  type CrossSample,
  type Pair,
  type PairRef,
  type SampleFace,
  type Spec,
  type SweepData,
} from "../src/engine.ts";
import type { Feedback, FeedbackKind } from "./feedback.ts";
import type { UploadBundle } from "./upload-bundle.ts";
import { shapeComparer, type PartFailure, type ShapeComparer } from "./verify-numeric.ts";

export type { CrossSample } from "../src/engine.ts";

/** 격자 보강을 허용하는 슬라이더 쌍 수, 상품당 */
export const GRID_PAIR_LIMIT = 2;

/** 쌍이 맞지 않을 때 힌트 끝에 붙는 고치는 방법(ADR-0008) */
const FIX_PAIR = "한쪽을 다른 쪽의 자식으로 두거나 두 범위를 좁히세요";

/** 두께 후보와 슬라이더가 맞지 않을 때 힌트 끝에 붙는 고치는 방법 */
const FIX_THICKNESS_PAIR = "모델에서 이 슬라이더의 수식(자식 수식 포함)에 두께가 섞여 있는지 확인하거나, 이 슬라이더의 범위를 좁히세요";

/** 격자로 섞을 수 없는 실패 종류. 이 실패가 있는 쌍은 보강하지 않는다. */
const UNMIXABLE = new Set<FeedbackKind>(["recompute_failed", "topology_change"]);

interface Corner {
  pair: Pair;
  /** 모든 슬라이더 값(쌍의 슬라이더는 범위 끝, 나머지는 default). 두께 쌍이면 두께 선택의 파라미터 값(두께 후보)도 있다. */
  values: Record<string, number>;
}

const defaultsOf = (spec: Spec) => Object.fromEntries(spec.sliders.map((s) => [s.id, s.default]));

/**
 * 교차 검증할 곳: 슬라이더 쌍마다 범위 모서리 4곳, 그다음 두께 선택마다 기본 두께가 아닌 후보마다 각 슬라이더의 범위 끝 2곳.
 * 슬라이더가 하나이고 두께 선택이 없으면 없다.
 */
function corners(spec: Spec): Corner[] {
  const defaults = defaultsOf(spec);
  const out: Corner[] = [];
  spec.sliders.forEach((a, i) => {
    spec.sliders.slice(i + 1).forEach((b) => {
      for (const va of [a.min, a.max]) {
        for (const vb of [b.min, b.max]) out.push({ pair: [a.id, b.id], values: { ...defaults, [a.id]: va, [b.id]: vb } });
      }
    });
  });
  for (const choice of spec.thickness) {
    for (const option of nonDefaultOptions(choice)) {
      for (const s of spec.sliders) {
        for (const v of [s.min, s.max]) out.push({ pair: [choice.ids[0], s.id], values: { ...defaults, ...thicknessValues(choice, option), [s.id]: v } });
      }
    }
  }
  return out;
}

/** 애드인에 요청할 교차 검증 샘플의 값 묶음. 응답은 같은 순서로 온다. */
export const crossCheckValues = (spec: Spec): Record<string, number>[] => corners(spec).map((c) => c.values);

/** 쌍이 이 명세의 두 슬라이더이거나 두께 쌍인지. 아니면 그 격자 보강은 이 명세에 쓰지 않는다. */
export const pairInSpec = (spec: Spec, pair: Pair) => findPair(spec, pair) !== undefined;

/** 쌍을 피드백에 쓰는 말: 가리킬 명세 위치, 힌트에 쓰는 쌍 이름(label), 고치는 방법(fix) */
interface PairWords {
  ref: PairRef;
  target: Pick<Feedback, "path" | "slider">;
  label: string;
  fix: string;
}

/**
 * 쌍을 피드백에 쓰는 말. 두 슬라이더면 앞 슬라이더를, 두께 쌍이면 그 두께 선택의 후보를 가리키고 slider는 함께 움직인 슬라이더다.
 * 명세에 없는 쌍이면 오류다.
 */
function pairWords(spec: Spec, pair: Pair): PairWords {
  const ref = findPair(spec, pair);
  if (!ref) throw new Error(`명세에 없는 쌍입니다: ${pair[0]}·${pair[1]}`);
  const [a, b] = pair;
  return ref.kind === "sliders"
    ? { ref, target: { path: `sliders[${ref.i}]`, slider: a }, label: `${a}와 ${b}`, fix: FIX_PAIR }
    : { ref, target: { path: `thickness[${ref.choice}].options`, slider: b }, label: `두께 ${a}와 ${b}`, fix: FIX_THICKNESS_PAIR };
}

/** 한 슬라이더의 격자 값: min·default·max. default가 범위 끝이면 겹치는 값은 하나로 둔다. */
const gridAxis = (s: Spec["sliders"][number]) => [...new Set([s.min, s.default, s.max])].sort((x, y) => x - y);

/** 이웃한 격자 값의 가운데 */
const midpoints = (values: number[]) => values.slice(1).map((v, k) => (values[k] + v) / 2);

/**
 * 격자 보강 쌍에 요청할 값 묶음. 나머지 슬라이더는 default다. 애드인에는 grid 다음에 checks를 이어 요청한다.
 * 두 슬라이더 쌍:
 * - grid: 두 슬라이더의 min·default·max를 엇건 격자(앞 슬라이더가 바깥 고리)
 * - checks: 격자 칸 가운데, 그다음 기본값 줄 위의 마디 사이 가운데(검증점). 격자 보강 쌍은 수치 검증에서 단독 스윕
 *   검증점을 재지 않으므로, 기본값 줄(한 슬라이더만 움직인 구성기 상태)도 여기서 잰다.
 * 두께 쌍: 기본 두께에서는 덧셈 그대로라(엔진이 격자를 더하지 않는다) 기본 두께가 아닌 후보만 뽑는다.
 * - grid: 후보마다 슬라이더의 min·default·max(후보가 바깥 고리)
 * - checks: 후보마다 슬라이더 마디 사이 가운데
 */
export function gridValues(spec: Spec, pair: Pair): { grid: Record<string, number>[]; checks: Record<string, number>[] } {
  const { ref } = pairWords(spec, pair);
  const defaults = defaultsOf(spec);
  if (ref.kind === "thickness") {
    const choice = spec.thickness[ref.choice];
    const s = spec.sliders[ref.j];
    const along = (vs: number[]) => nonDefaultOptions(choice).flatMap((o) => vs.map((v) => ({ ...defaults, ...thicknessValues(choice, o), [s.id]: v })));
    return { grid: along(gridAxis(s)), checks: along(midpoints(gridAxis(s))) };
  }
  const [a, b] = [spec.sliders[ref.i], spec.sliders[ref.j]];
  const cross = (as: number[], bs: number[]) => as.flatMap((va) => bs.map((vb) => ({ ...defaults, [a.id]: va, [b.id]: vb })));
  const [ga, gb] = [gridAxis(a), gridAxis(b)];
  return {
    grid: cross(ga, gb),
    checks: [...cross(midpoints(ga), midpoints(gb)), ...cross(midpoints(ga), [b.default]), ...cross([a.default], midpoints(gb))],
  };
}

/**
 * 쌍 하나의 값 묶음에서 받은 Fusion 형상을 변형 결과와 비교한다. 피드백은 words.target을 가리킨다.
 * 두께 쌍에서 판 두께가 어긋나면 thickness_change다. 엔진은 고른 두께를 그대로 두므로(기본 두께에서는 두께 고정 실측으로
 * 확인했다), 어긋남은 그 두께 후보에서 슬라이더가 판 두께를 바꾼다는 뜻이다.
 */
function comparePairSample(compare: ShapeComparer, words: PairWords, [a, b]: Pair, sample: CrossSample, hintTail: string): Feedback[] {
  const { values } = sample;
  const pairValues = { [a]: values[a], [b]: values[b] };
  const place = placeOf(pairValues);
  const feedback = (failure: PartFailure): Feedback => {
    const measured = failure.measured as { dimension?: string; engine_mm?: number; fusion_mm?: number };
    if (words.ref.kind === "sliders" || failure.kind !== "dimension_error" || measured.dimension !== "thickness") return { ...words.target, ...failure };
    return {
      ...words.target,
      ...failure,
      kind: "thickness_change",
      hint: `슬라이더 ${b}가 두께 ${a}=${values[a]}에서 부품 ${failure.part}의 두께를 바꿉니다: ${place}에서 ${measured.engine_mm} mm여야 하는데 Fusion은 ${measured.fusion_mm} mm. ${FIX_THICKNESS_PAIR}`,
    };
  };

  // 부품과 무관한 실패는 part를 비워 둔다.
  if (sample.status !== "ok") {
    return [feedback({ part: "", kind: "recompute_failed", measured: { values: pairValues }, expected: "재계산 성공", hint: `Fusion이 ${place}에서 재계산하지 못합니다. ${hintTail}` })];
  }
  const failures = compare(values, sample.faces, { measured: { values: pairValues }, place, hintTail });
  if (!failures) {
    return [feedback({ part: "", kind: "topology_change", measured: { values: pairValues }, expected: "기본 형상과 같은 면 구성", hint: `${place}에서 면 구성이 기본 형상과 다릅니다. ${hintTail}` })];
  }
  return failures.map(feedback);
}

/** 교차 검증에 실패한 쌍과 그 피드백 */
export interface PairFailure {
  pair: Pair;
  feedback: Feedback[];
}

/**
 * 교차 검증 샘플에서 합격선을 넘은 쌍을 corners 순서(슬라이더 쌍, 그다음 두께 쌍)로 돌려준다. 통과하면 빈 목록이다.
 * samples는 crossCheckValues(spec)의 순서대로 받은 Fusion 형상이다.
 * 피드백은 pairWords의 target을 가리키고, measured.values에 쌍의 두 값이 있다.
 */
export function verifyCross(spec: Spec, sweeps: SweepData, bundle: UploadBundle, samples: CrossSample[]): PairFailure[] {
  const compare = shapeComparer(spec, sweeps, bundle);
  const out: PairFailure[] = [];
  corners(spec).forEach(({ pair }, n) => {
    const words = pairWords(spec, pair);
    const hintTail = `${words.label}를 함께 움직이면 덧셈이 맞지 않습니다. ${words.fix}`;
    const feedback = comparePairSample(compare, words, pair, samples[n], hintTail);
    if (feedback.length === 0) return;
    // 두께 쌍은 후보마다 따로 놓이므로 같은 쌍이 떨어져 나온다
    const found = out.find((f) => samePair(f.pair, pair));
    if (found) found.feedback.push(...feedback);
    else out.push({ pair, feedback });
  });
  return out;
}

/** 격자 보강으로 고칠 수 있는 실패인지. 재계산 실패와 위상 변화는 격자로 섞을 수 없다. */
export const fixableByGrid = ({ feedback }: PairFailure) => feedback.every((f) => !UNMIXABLE.has(f.kind));

/** 샘플의 면 구성이 기준 형상과 같은지: (바디, 이름)과 점 수 */
function sameFaces(baseline: SweepData["baseline"], faces: SampleFace[]): boolean {
  const counts = new Map(baseline.faces.map((f) => [faceKey(f), f.points.length]));
  return faces.length === counts.size && faces.every((f) => counts.get(faceKey(f)) === f.points.length);
}

/**
 * 받은 격자 샘플을 엔진에 넣을 수 있는지 본다. 재계산 실패나 위상 변화가 있으면 그 피드백을 돌려준다.
 * grid는 gridValues(spec, pair).grid의 순서대로 받은 Fusion 형상이다.
 */
export function checkGridSamples(spec: Spec, sweeps: SweepData, pair: Pair, grid: CrossSample[]): Feedback[] {
  const words = pairWords(spec, pair);
  const [a, b] = pair;
  const hintTail = `${words.label}의 격자 보강 샘플을 뽑을 수 없습니다. ${words.fix}`;
  return grid.flatMap(({ values, status, faces }) => {
    const pairValues = { [a]: values[a], [b]: values[b] };
    const target = { ...words.target, part: "", measured: { values: pairValues } };
    return unusableSample({ status, faces }, sweeps.baseline, target, placeOf(pairValues), hintTail);
  });
}

/**
 * 엔진에 넣을 추가 샘플(격자 보강·두께 후보 형상)이 재계산에 실패했거나 기준 형상과 면 구성이 다르면 그 피드백 하나를,
 * 넣을 수 있으면 빈 목록을 돌려준다. target은 피드백이 가리킬 명세 위치와 잰 값이다.
 */
export function unusableSample(
  sample: Pick<CrossSample, "status" | "faces">,
  baseline: SweepData["baseline"],
  target: Pick<Feedback, "path" | "slider" | "part" | "measured">,
  place: string,
  hintTail: string,
): Feedback[] {
  if (sample.status !== "ok") return [{ ...target, kind: "recompute_failed", expected: "재계산 성공", hint: `Fusion이 ${place}에서 재계산하지 못합니다. ${hintTail}` }];
  if (!sameFaces(baseline, sample.faces)) return [{ ...target, kind: "topology_change", expected: "기준 형상과 같은 면 구성", hint: `${place}에서 면 구성이 기준 형상과 다릅니다. ${hintTail}` }];
  return [];
}

/**
 * 격자 보강 쌍의 검증점에서 격자 보간 결과를 Fusion 형상과 비교한다. 통과하면 빈 목록이다.
 * sweeps에는 이 쌍의 격자가 들어 있어야 하고, checks는 gridValues(spec, pair).checks의 순서대로 받은 형상이다.
 */
export function verifyGrid(spec: Spec, sweeps: SweepData, bundle: UploadBundle, pair: Pair, checks: CrossSample[]): Feedback[] {
  const compare = shapeComparer(spec, sweeps, bundle);
  const words = pairWords(spec, pair);
  const hintTail = `${words.label}는 격자 보간으로도 맞지 않습니다. ${words.fix}`;
  return checks.flatMap((sample) => comparePairSample(compare, words, pair, sample, hintTail));
}

/** 격자 보강이 필요한 쌍이 GRID_PAIR_LIMIT를 넘었다는 피드백. 한 슬라이더·부품의 실패가 아니므로 slider·part를 비워 둔다. */
export function gridLimitFeedback(pairs: Pair[]): Feedback {
  return {
    path: "sliders",
    slider: "",
    part: "",
    kind: "grid_limit",
    measured: { pairs },
    expected: { max_pairs: GRID_PAIR_LIMIT },
    hint: `덧셈이 맞지 않아 격자 보강이 필요한 슬라이더 쌍이 ${pairs.length}쌍으로, 상품당 ${GRID_PAIR_LIMIT}쌍을 넘습니다. 한쪽을 다른 쪽의 자식으로 두거나 슬라이더를 줄이세요`,
  };
}
