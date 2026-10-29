// 교차 검증: 슬라이더 쌍마다 범위 모서리 조합에서 Fusion 형상을 받아, 단독 스윕 이동량을 더한 변형 결과와 비교한다(ADR-0004).
// 덧셈이 틀리는 쌍은 3×3 격자로 보강하고, 격자 마디 사이의 검증점에서 격자 보간을 확인한다(ADR-0008).
// 합격선과 재는 방법은 수치 검증과 같다(ADR-0012).
import { faceKey, type CrossSample, type Pair, type SampleFace, type Spec, type SweepData } from "../src/engine.ts";
import type { Feedback, FeedbackKind } from "./feedback.ts";
import type { UploadBundle } from "./upload-bundle.ts";
import { shapeComparer, type PartFailure, type ShapeComparer } from "./verify-numeric.ts";

export type { CrossSample } from "../src/engine.ts";

/** 격자 보강을 허용하는 슬라이더 쌍 수, 상품당 */
export const GRID_PAIR_LIMIT = 2;

/** 쌍이 맞지 않을 때 힌트 끝에 붙는 고치는 방법(ADR-0008) */
const FIX_PAIR = "한쪽을 다른 쪽의 자식으로 두거나 두 범위를 좁히세요";

/** 격자로 섞을 수 없는 실패 종류. 이 실패가 있는 쌍은 보강하지 않는다. */
const UNMIXABLE = new Set<FeedbackKind>(["recompute_failed", "topology_change"]);

interface Corner {
  /** 쌍의 두 슬라이더 번호 */
  pair: [number, number];
  /** 모든 슬라이더 값. 쌍은 범위 끝, 나머지는 default */
  values: Record<string, number>;
}

const defaultsOf = (spec: Spec) => Object.fromEntries(spec.sliders.map((s) => [s.id, s.default]));

/** 슬라이더 쌍마다 범위 모서리 4곳. 슬라이더가 하나면 없다. */
function corners(spec: Spec): Corner[] {
  const defaults = defaultsOf(spec);
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

/** 쌍의 두 슬라이더 번호. 명세에 없는 쌍이면 오류다. */
function pairIndex(spec: Spec, [a, b]: Pair): [number, number] {
  const i = spec.sliders.findIndex((s) => s.id === a);
  const j = spec.sliders.findIndex((s) => s.id === b);
  if (i === -1 || j === -1) throw new Error(`명세에 없는 슬라이더 쌍입니다: ${a}·${b}`);
  return [i, j];
}

/** 한 슬라이더의 격자 값: min·default·max. default가 범위 끝이면 겹치는 값은 하나로 둔다. */
const gridAxis = (s: Spec["sliders"][number]) => [...new Set([s.min, s.default, s.max])].sort((x, y) => x - y);

/** 이웃한 격자 값의 가운데 */
const midpoints = (values: number[]) => values.slice(1).map((v, k) => (values[k] + v) / 2);

/**
 * 격자 보강 쌍에 요청할 값 묶음. 나머지 슬라이더는 default다. 애드인에는 grid 다음에 checks를 이어 요청한다.
 * - grid: 두 슬라이더의 min·default·max를 엇건 격자(앞 슬라이더가 바깥 고리)
 * - checks: 격자 칸 가운데, 그다음 기본값 줄 위의 마디 사이 가운데(검증점). 격자 보강 쌍은 수치 검증에서 단독 스윕
 *   검증점을 재지 않으므로, 기본값 줄(한 슬라이더만 움직인 구성기 상태)도 여기서 잰다.
 */
export function gridValues(spec: Spec, pair: Pair): { grid: Record<string, number>[]; checks: Record<string, number>[] } {
  const [a, b] = pairIndex(spec, pair).map((i) => spec.sliders[i]);
  const defaults = defaultsOf(spec);
  const cross = (as: number[], bs: number[]) => as.flatMap((va) => bs.map((vb) => ({ ...defaults, [a.id]: va, [b.id]: vb })));
  const [ga, gb] = [gridAxis(a), gridAxis(b)];
  return {
    grid: cross(ga, gb),
    checks: [...cross(midpoints(ga), midpoints(gb)), ...cross(midpoints(ga), [b.default]), ...cross([a.default], midpoints(gb))],
  };
}

/** 쌍 하나의 값 묶음에서 받은 Fusion 형상을 변형 결과와 비교한다. 피드백은 쌍의 앞 슬라이더를 가리킨다. */
function comparePairSample(
  compare: ShapeComparer,
  spec: Spec,
  [i, j]: [number, number],
  sample: CrossSample,
  hintTail: string,
): Feedback[] {
  const [a, b] = [spec.sliders[i], spec.sliders[j]];
  const { values } = sample;
  const pairValues = { [a.id]: values[a.id], [b.id]: values[b.id] };
  const place = `${a.id}=${values[a.id]}·${b.id}=${values[b.id]}`;
  const feedback = (failure: PartFailure): Feedback => ({ path: `sliders[${i}]`, slider: a.id, ...failure });

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
 * 교차 검증 샘플에서 합격선을 넘은 쌍을 명세 순서대로 돌려준다. 통과하면 빈 목록이다.
 * samples는 crossCheckValues(spec)의 순서대로 받은 Fusion 형상이다.
 * 피드백은 쌍의 앞 슬라이더를 가리키고, measured.values에 쌍의 두 값이 있다.
 */
export function verifyCross(spec: Spec, sweeps: SweepData, bundle: UploadBundle, samples: CrossSample[]): PairFailure[] {
  const compare = shapeComparer(spec, sweeps, bundle);
  const out: PairFailure[] = [];
  corners(spec).forEach(({ pair: [i, j] }, n) => {
    const pair: Pair = [spec.sliders[i].id, spec.sliders[j].id];
    const hintTail = `${pair[0]}와 ${pair[1]}를 함께 움직이면 덧셈이 맞지 않습니다. ${FIX_PAIR}`;
    const feedback = comparePairSample(compare, spec, [i, j], samples[n], hintTail);
    if (feedback.length === 0) return;
    const last = out.at(-1);
    if (last && last.pair[0] === pair[0] && last.pair[1] === pair[1]) last.feedback.push(...feedback);
    else out.push({ pair, feedback });
  });
  return out;
}

/** 격자 보강으로 고칠 수 있는 실패인지. 재계산 실패와 위상 변화는 격자로 섞을 수 없다. */
export const fixableByGrid = ({ feedback }: PairFailure) => feedback.every((f) => !UNMIXABLE.has(f.kind));

/** 샘플의 면 구성이 기본 형상과 같은지: (바디, 이름)과 점 수 */
function sameFaces(sweeps: SweepData, faces: SampleFace[]): boolean {
  const counts = new Map(sweeps.baseline.faces.map((f) => [faceKey(f), f.points.length]));
  return faces.length === counts.size && faces.every((f) => counts.get(faceKey(f)) === f.points.length);
}

/**
 * 받은 격자 샘플을 엔진에 넣을 수 있는지 본다. 재계산 실패나 위상 변화가 있으면 그 피드백을 돌려준다.
 * grid는 gridValues(spec, pair).grid의 순서대로 받은 Fusion 형상이다.
 */
export function checkGridSamples(spec: Spec, sweeps: SweepData, pair: Pair, grid: CrossSample[]): Feedback[] {
  const [i, j] = pairIndex(spec, pair);
  const [a, b] = [spec.sliders[i].id, spec.sliders[j].id];
  const hintTail = `${a}와 ${b}의 격자 보강 샘플을 뽑을 수 없습니다. ${FIX_PAIR}`;
  return grid.flatMap(({ values, status, faces }): Feedback[] => {
    const place = `${a}=${values[a]}·${b}=${values[b]}`;
    const base = { path: `sliders[${i}]`, slider: a, part: "", measured: { values: { [a]: values[a], [b]: values[b] } } };
    if (status !== "ok") return [{ ...base, kind: "recompute_failed", expected: "재계산 성공", hint: `Fusion이 ${place}에서 재계산하지 못합니다. ${hintTail}` }];
    if (!sameFaces(sweeps, faces)) return [{ ...base, kind: "topology_change", expected: "기본 형상과 같은 면 구성", hint: `${place}에서 면 구성이 기본 형상과 다릅니다. ${hintTail}` }];
    return [];
  });
}

/**
 * 격자 보강 쌍의 검증점에서 격자 보간 결과를 Fusion 형상과 비교한다. 통과하면 빈 목록이다.
 * sweeps에는 이 쌍의 격자가 들어 있어야 하고, checks는 gridValues(spec, pair).checks의 순서대로 받은 형상이다.
 */
export function verifyGrid(spec: Spec, sweeps: SweepData, bundle: UploadBundle, pair: Pair, checks: CrossSample[]): Feedback[] {
  const compare = shapeComparer(spec, sweeps, bundle);
  const index = pairIndex(spec, pair);
  const hintTail = `${pair[0]}와 ${pair[1]}는 격자 보간으로도 맞지 않습니다. ${FIX_PAIR}`;
  return checks.flatMap((sample) => comparePairSample(compare, spec, index, sample, hintTail));
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
