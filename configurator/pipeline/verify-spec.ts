// AI 없는 검증 순서: 두께 후보 형상 → 조립 → 범위 → 두께 고정 실측 → 수치 → 축 반응 → 교차 검증 → 실패한 쌍의 격자 보강과 격자 검증점.
// 실행기(runner.ts)가 명세를 쓸 때마다 부르고, 실제 녹화본으로 검증 단계를 돌리는 도구(scripts/verify-recording.ts)도 부른다.
// 추가 샘플은 부르는 쪽이 sampleRequester로 만든 requestSamples로 받는다. 연결 끊김을 어떻게 다룰지는 부르는 쪽이 정한다.
import { samePair, thicknessSamplePlan, type GridSweep, type Pair, type Spec, type SweepData } from "../src/engine.ts";
import type { Style } from "../src/style.ts";
import { assembleProduct, type ProductFiles } from "./assemble.ts";
import type { Feedback } from "./feedback.ts";
import { checkSampleResponse } from "./schemas.ts";
import type { UploadBundle } from "./upload-bundle.ts";
import { verifyAxisResponse } from "./verify-axis.ts";
import {
  checkGridSamples,
  crossCheckValues,
  fixableByGrid,
  GRID_PAIR_LIMIT,
  gridLimitFeedback,
  gridValues,
  pairInSpec,
  verifyCross,
  verifyGrid,
  type CrossSample,
  type PairFailure,
} from "./verify-cross.ts";
import { verifyNumeric } from "./verify-numeric.ts";
import { checkThicknessSamples, verifyThicknessFixed } from "./verify-thickness.ts";
import { verifyRange } from "./verify-range.ts";

/** 추가 샘플 요청(ADR-0013). 응답 형식은 업로드 묶음의 샘플과 같다. */
export interface SampleRequest {
  kind: "cross" | "grid" | "thickness";
  values: Record<string, number>[];
}

/** 받은 격자 보강. key는 요청한 값 묶음이라, 명세의 범위나 기본값이 바뀌면 그 격자는 쓰지 않는다. */
export interface Reinforcement {
  pair: Pair;
  key: string;
  sweep: GridSweep;
  /** 격자 마디 사이 검증점의 Fusion 형상 */
  checks: CrossSample[];
}

/**
 * 검증 단계. grid_checks는 격자 보강 쌍의 격자 검증점을 재는 단계, grid_reinforcement는 격자를 받지 못한 까닭
 * (엔진에 넣을 수 없는 격자, 격자 쌍 상한)의 피드백이다.
 */
export type VerifyStage = "thickness_samples" | "range" | "thickness_fixed" | "numeric" | "axis" | "cross" | "grid_checks" | "grid_reinforcement";

/** 단계 하나의 피드백. reinforced는 격자 보강을 받아 같은 명세를 다시 검증한 회차다. 빈 피드백은 통과다. */
export interface StageResult {
  stage: VerifyStage;
  reinforced: boolean;
  feedback: Feedback[];
}

export interface VerifyInput {
  spec: Spec;
  bundle: UploadBundle;
  style: Style;
  /** 앞서 받은 격자 보강. 이 명세에 맞는 것(쌍이 명세에 있고 값 묶음이 같은 것)만 쓴다. */
  reinforcements: Reinforcement[];
  requestSamples: (request: SampleRequest) => Promise<CrossSample[]>;
  /** 교차 검증에 실패한 쌍 중 격자로 보강할 쌍인지. 격자로 고칠 수 있고 아직 보강하지 않은 쌍만 묻는다. */
  shouldReinforce: (pair: Pair) => boolean;
  /** true면 첫 실패 단계에서 멈추지 않고 모든 단계를 본다(실제 녹화본 확인 도구). 실행기는 첫 실패에서 멈춘다. */
  keepGoing?: boolean;
  /** 조립을 마칠 때와 격자를 받을 때 불린다 */
  onAssembled?: () => Promise<void>;
  /** 단계를 마칠 때마다 불린다. 뒤 단계에서 추가 샘플을 받지 못해 끝나도 앞 단계 결과가 남는다. */
  onStage?: (result: StageResult) => void;
  onGrid?: (pair: Pair) => Promise<void>;
}

export interface Verified {
  /** 마지막 회차의 결과물 */
  files: ProductFiles;
  /** 마지막 회차의 피드백(격자 보강 피드백 포함). 비었으면 통과다. */
  feedback: Feedback[];
  /** 회차마다 본 단계 */
  stages: StageResult[];
  /** 첫 회차 교차 검증에서 실패한 쌍 */
  failedPairs: PairFailure[];
  /** 이번에 새로 받은 격자 보강. 다른 쌍이 실패해도 다음 명세에서 쓴다. */
  added: Reinforcement[];
}

/** 추가 샘플 응답을 검사한다. 형식이 틀렸거나 값 묶음이 요청과 다르면 그 오류 목록이다. */
function samplesOf(request: SampleRequest, response: unknown): { samples: CrossSample[] } | { errors: string[] } {
  const errors = checkSampleResponse(response);
  if (errors.length > 0) return { errors: errors.map((e) => `애드인 응답 형식 오류: ${e}`) };
  const { samples } = response as { samples: CrossSample[] };
  // 서버도 같은 검사를 하지만, 포트 구현이 서버를 거치지 않을 수도 있어 여기서 한 번 더 본다.
  if (JSON.stringify(samples.map((s) => s.values)) !== JSON.stringify(request.values)) return { errors: ["애드인 응답의 값 묶음이 요청과 다릅니다"] };
  return { samples };
}

/**
 * 추가 샘플 요청 함수를 만든다. ask는 애드인의 응답(검사 전)을 받아 오고, 연결 끊김과 애드인이 샘플을 뽑지 못한 경우는
 * ask가 부르는 쪽 방식대로 처리한다(실행기는 다시 연결되기를 기다리고, 실제 녹화본 확인 도구는 바로 끝낸다).
 * 응답이 형식에 맞지 않으면 rejected가 만든 오류를 던진다. 같은 요청에는 같은 형상이 오므로 받은 샘플은 다시 요청하지 않는다.
 */
export function sampleRequester(ask: (request: SampleRequest) => Promise<unknown>, rejected: (reason: string) => Error): (request: SampleRequest) => Promise<CrossSample[]> {
  const answered = new Map<string, CrossSample[]>();
  return async (request) => {
    const key = JSON.stringify(request);
    const cached = answered.get(key);
    if (cached) return cached;
    const checked = samplesOf(request, await ask(request));
    if ("errors" in checked) throw rejected(checked.errors.join("; "));
    answered.set(key, checked.samples);
    return checked.samples;
  };
}

/** 애드인이 추가 샘플을 뽑지 못했을 때의 까닭 */
export const samplesFailed = (reason: string) => `애드인이 추가 샘플을 뽑지 못했습니다: ${reason}`;

const gridKey = (spec: Spec, pair: Pair) => JSON.stringify(gridValues(spec, pair));

/** 이 명세에 쓸 수 있는 격자: 쌍(두 슬라이더, 또는 두께 선택과 슬라이더)이 명세에 있고, 요청한 값 묶음이 지금 범위·기본값·두께 후보와 같다 */
const gridsFor = (spec: Spec, reinforcements: Reinforcement[]) => reinforcements.filter((r) => pairInSpec(spec, r.pair) && r.key === gridKey(spec, r.pair));

const feedbackOf = (stages: StageResult[]) => stages.flatMap((s) => s.feedback);

/**
 * 조립하고 범위 → 두께 고정 실측 → 수치 검증 → 축 반응 → 교차 검증(격자 보강 쌍은 격자 검증점까지)을 차례로 본다.
 * keepGoing이 아니면 첫 실패 단계에서 멈춘다.
 */
async function verifyOnce(input: VerifyInput, grids: Reinforcement[], reinforced: boolean) {
  const { spec, bundle, style, requestSamples, keepGoing = false } = input;
  // 두께 선택이 있으면 두께 후보 형상을 애드인에 받아 결과물에 담는다(ADR-0010). 엔진에 넣을 수 없는 형상이면 재기 전에 돌려준다.
  const plan = thicknessSamplePlan(spec, bundle);
  const thickness = plan.length === 0 ? [] : await requestSamples({ kind: "thickness", values: plan.map((p) => p.values) });
  const files = await assembleProduct(spec, { ...bundle, grids: grids.map((r) => r.sweep), thickness }, style);
  await input.onAssembled?.();

  const stages: StageResult[] = [];
  const record = (stage: VerifyStage, feedback: Feedback[]) => {
    const result = { stage, reinforced, feedback };
    stages.push(result);
    input.onStage?.(result);
  };
  const stopped = () => !keepGoing && stages.some((s) => s.feedback.length > 0);
  const run = (stage: VerifyStage, check: () => Feedback[]) => {
    if (!stopped()) record(stage, check());
  };
  if (plan.length > 0) run("thickness_samples", () => checkThicknessSamples(plan, thickness));

  // 두께 고정 실측은 녹화된 단독 스윕으로, 수치 검증은 결과물에 담긴 스윕 데이터로 잰다. 통과하면 축 반응을 녹화된 단독 스윕으로 보고,
  // 그것도 통과하면 애드인에 교차 검증 샘플을 받아 슬라이더 덧셈을 본다.
  // 슬라이더가 애드인이 줄인 스윕 범위를 넘으면 엔진이 그 밖을 끝 샘플에 붙이므로, 재기 전에 범위부터 좁히게 한다.
  const sweeps: SweepData = JSON.parse(files["sweeps.json"]);
  run("range", () => verifyRange(spec, bundle));
  // 두께 고정 실측은 수치 검증보다 먼저 본다. 슬라이더가 판 두께를 바꾸면 수치 검증의 판 두께 치수 오차보다
  // "슬라이더 X가 부품 Y의 두께를 바꿈"이 원인을 바로 가리키고, 비율 수식이면 수치 검증은 통과하기 때문이다.
  run("thickness_fixed", () => verifyThicknessFixed(spec, sweeps, bundle));
  run("numeric", () => verifyNumeric(spec, sweeps, bundle));
  run("axis", () => verifyAxisResponse(spec, bundle));

  const crossValues = crossCheckValues(spec);
  let failedPairs: PairFailure[] = [];
  if (crossValues.length > 0 && !stopped()) {
    const samples = await requestSamples({ kind: "cross", values: crossValues });
    failedPairs = verifyCross(spec, sweeps, bundle, samples);
    record("cross", failedPairs.flatMap((f) => f.feedback));
    if (grids.length > 0) record("grid_checks", grids.flatMap((r) => verifyGrid(spec, sweeps, bundle, r.pair, r.checks)));
  }
  return { files, stages, failedPairs };
}

/**
 * 쌍마다 격자와 그 검증점을 애드인에 요청한다. 엔진에 넣을 수 있는 격자는 added로,
 * 넣을 수 없는 격자(재계산 실패·위상 변화)는 그 피드백을 problems로 돌려준다.
 */
async function reinforcePairs(input: VerifyInput, pairs: Pair[]): Promise<{ added: Reinforcement[]; problems: Feedback[] }> {
  const { spec, bundle, requestSamples } = input;
  const added: Reinforcement[] = [];
  const problems: Feedback[] = [];
  for (const pair of pairs) {
    const { grid, checks } = gridValues(spec, pair);
    const samples = await requestSamples({ kind: "grid", values: [...grid, ...checks] });
    const gridSamples = samples.slice(0, grid.length);
    const unusable = checkGridSamples(spec, bundle, pair, gridSamples);
    if (unusable.length > 0) {
      problems.push(...unusable);
      continue;
    }
    added.push({ pair, key: gridKey(spec, pair), sweep: { parameters: pair, samples: gridSamples }, checks: samples.slice(grid.length) });
    await input.onGrid?.(pair);
  }
  return { added, problems };
}

/**
 * 명세 하나를 검증한다. 교차 검증에 실패한 쌍 중 reinforce가 고른 쌍은 3×3 격자로 보강해(ADR-0008) 같은 명세를 한 번 더 검증한다.
 * 격자 쌍이 GRID_PAIR_LIMIT를 넘거나 넣을 수 없는 격자가 오면 그 피드백을 붙이고 다시 검증하지 않는다.
 */
export async function verifySpec(input: VerifyInput): Promise<Verified> {
  const grids = gridsFor(input.spec, input.reinforcements);
  const first = await verifyOnce(input, grids, false);
  const result: Verified = { files: first.files, feedback: feedbackOf(first.stages), stages: first.stages, failedPairs: first.failedPairs, added: [] };
  const toReinforce = first.failedPairs
    .filter((f) => fixableByGrid(f) && !grids.some((r) => samePair(r.pair, f.pair)) && input.shouldReinforce(f.pair))
    .map((f) => f.pair);
  if (toReinforce.length === 0) return result;

  /** 격자를 받지 못한 까닭을 첫 회차 결과에 붙인다 */
  const unreinforced = (feedback: Feedback[], added: Reinforcement[]): Verified => {
    const stage: StageResult = { stage: "grid_reinforcement", reinforced: false, feedback };
    input.onStage?.(stage);
    return { ...result, feedback: [...result.feedback, ...feedback], stages: [...result.stages, stage], added };
  };
  const needed = [...grids.map((r) => r.pair), ...toReinforce];
  if (needed.length > GRID_PAIR_LIMIT) return unreinforced([gridLimitFeedback(needed)], []);
  const { added, problems } = await reinforcePairs(input, toReinforce);
  if (problems.length > 0) return unreinforced(problems, added);
  const second = await verifyOnce(input, gridsFor(input.spec, [...input.reinforcements, ...added]), true);
  return { ...result, files: second.files, feedback: feedbackOf(second.stages), stages: [...first.stages, ...second.stages], added };
}
