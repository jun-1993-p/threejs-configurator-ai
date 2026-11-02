// 파이프라인 실행기: 상품 하나를 10단계 고정 순서로 진행한다(ADR-0014). AI는 단계 안에서 정해진 형식으로만 답한다.
// 바깥 의존은 Fusion 연결·AI 모델·저장소 세 포트로만 접근한다.
import { samePair, thicknessSamplePlan, type Axis, type GridSweep, type Pair, type Spec, type SweepData } from "../src/engine.ts";
import { assembleProduct, type ProductFiles } from "./assemble.ts";
import { candidateCards, partViews, pickParent, type CandidateCard, type PartColor, type PartView } from "./candidate-cards.ts";
import type { Feedback } from "./feedback.ts";
import {
  candidateDiversityChecker,
  candidateReferenceChecker,
  checkCandidates,
  checkIntake,
  checkParts,
  checkSampleResponse,
  checkSpec,
  checkUploadBundle,
  chosenCandidateChecker,
  fixedThicknessChecker,
  partsReferenceChecker,
  specReferenceChecker,
  styleChoiceChecker,
  thicknessChoiceChecker,
  UNREADABLE_ANSWER,
  type Check,
  type ChosenSlider,
  type Front,
  type FusionAxis,
  type ProductKind,
  type ThicknessExposure,
} from "./schemas.ts";
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
import { rangeIntersection, type DimensionRule } from "./range-intersection.ts";
import { checkThicknessSamples, verifyThicknessFixed } from "./verify-thickness.ts";
import { uploadRangeFeedback, verifyRange } from "./verify-range.ts";

/** 단계 이름. 순서는 runPipeline의 코드가 정한다. */
export type Stage =
  | "upload"
  | "intake"
  | "candidates"
  | "choice"
  | "style"
  | "spec"
  | "assembly"
  | "verification"
  | "approval"
  | "submission";

/** 정보 입력 */
export interface Intake {
  name: string;
  /** 상품 종류(서랍장·책장·수납장·테이블 등) */
  kind: ProductKind;
  /** 원하는 슬라이더와 범위 메모(자유 문장) */
  memo: string;
  /** 두께 선택 노출 여부. ai는 "AI 판단" */
  thickness: ThicknessExposure;
}

export type { Front };

/** 후보의 슬라이더 하나: 고객이 보는 치수의 파라미터(부모 또는 자식)와 그 뜻의 슬라이더 이름 */
export interface CandidateSlider {
  parameter: string;
  name: string;
}

/** 슬라이더 구성 후보 */
export interface Candidate {
  id: string;
  front: Front;
  /** 노출할 치수. 자식 파라미터면 움직일 부모를 후보 선택에서 운영자가 고른다(ADR-0003). */
  sliders: CandidateSlider[];
  showThickness: boolean;
  summary: string;
  /** 다른 후보와의 차이 한 줄 */
  diff: string;
}

/** 운영자가 고른 후보: 카드에 보인 축 대응이 붙고 슬라이더마다 움직일 부모가 정해진 것. 스타일 고르기와 명세 작성의 입력이다. */
export interface ChosenCandidate extends Omit<Candidate, "sliders"> {
  axes: Record<Axis, FusionAxis>;
  sliders: ChosenSlider[];
}

/** 부품 탐색(VLM) 결과: 그림에서 찾은 부품의 역할, 정면 후보(확신 순서, 하나면 확신), 위쪽 방향 */
export interface PartsFound {
  parts: { name: string; role: string }[];
  fronts: Front[];
  up: Front;
}

export interface Style {
  id: string;
}

/** 같은 후보로 검증을 통과하지 못해 후보 제시로 돌아온 기록. feedback은 마지막 시도의 것이다. */
export interface CandidateFailure {
  candidate: Candidate;
  feedback: Feedback[];
}

export interface LogEntry {
  /** 정보 입력의 상품명 */
  product: string;
  stage: Stage;
  at: string;
  detail?: unknown;
}

export interface CaseRecord {
  kind: string;
  intake: Intake;
  candidates: Candidate[];
  chosen: string;
  spec: Spec;
}

/** 추가 샘플 요청(ADR-0013). 응답 형식은 업로드 묶음의 샘플과 같다. */
export interface SampleRequest {
  kind: "cross" | "grid" | "thickness";
  values: Record<string, number>[];
}

/**
 * 추가 샘플 요청의 결과. 응답은 검사 전이라 unknown이고, 형식은 업로드 묶음 스키마의 sampleResponse다.
 * 애드인 연결이 끊겨 있으면 disconnected, 애드인이 샘플을 뽑지 못했으면 그 이유와 함께 failed다.
 */
export type SampleAnswer =
  | { status: "answered"; response: unknown }
  | { status: "disconnected" }
  | { status: "failed"; reason: string };

/** Fusion 연결 포트: 업로드부터 최종 승인까지 연결된 CAD 애드인(ADR-0013) */
export interface FusionPort {
  requestSamples(request: SampleRequest): Promise<SampleAnswer>;
  /** 애드인이 다시 연결되면 끝난다 */
  reconnected(): Promise<void>;
}

/** 애드인 연결이 끊겼을 때와 다시 연결됐을 때 처리 기록에 보이는 상태 */
export const FUSION_NEEDED = "Fusion 연결 필요";
export const FUSION_RECONNECTED = "다시 연결됨";

/** AI 단계. AI 모델 포트의 메서드마다 하나다. */
export const AI_STAGES = ["parts", "candidates", "style", "spec"] as const;
export type AiStage = (typeof AI_STAGES)[number];

/**
 * AI 모델 포트. 응답은 검사 전이라 unknown이다. 실행기가 JSON Schema로 검사하고,
 * 형식이 틀리면 schemaErrors와 그 응답(rejected)을 붙여 다시 묻는다. 형식 검사에 걸린 응답이 없으면 rejected는 null이다.
 * 모델이 낸 문장을 JSON으로 읽을 수 없으면 그 문장(string)을 돌려준다. 단계마다 응답은 객체나 배열이라 문자열은 늘 형식 오류다.
 */
export interface AiPort {
  /**
   * 부품 탐색(VLM). 기본 형상을 여섯 방향에서 본 그림(views)과 그림 속 부품 색(colors)을 보고 부품의 역할과 정면·위쪽을 찾는다.
   * 후보 제시 전에 상품마다 한 번 부른다.
   */
  findParts(input: { intake: Intake; views: PartView[]; colors: PartColor[]; rejected: unknown; schemaErrors: string[] }): Promise<unknown>;
  proposeCandidates(input: {
    bundle: unknown;
    intake: Intake;
    /** 부품 탐색 결과. 정면 후보가 여럿이면 후보끼리 그 정면을 모두 써야 한다. */
    parts: PartsFound;
    failures: CandidateFailure[];
    rejected: unknown;
    schemaErrors: string[];
  }): Promise<unknown>;
  chooseStyle(input: { intake: Intake; candidate: ChosenCandidate; styles: Style[]; rejected: unknown; schemaErrors: string[] }): Promise<unknown>;
  writeSpec(input: {
    bundle: unknown;
    intake: Intake;
    /** 운영자가 고른 후보. 슬라이더 id는 parent, 이름은 name이고, parent가 parameter와 다르면 children에 parameter를 적는다. */
    candidate: ChosenCandidate;
    /** 정보 입력의 상품 종류로 거른 치수 규칙. 슬라이더 범위와 source는 여기서 고른다(ADR-0009). */
    rules: DimensionRule[];
    /** 검증 피드백(feedback)을 받은 명세. 처음 쓰는 것이면 null이다. 형식 재요청 중에도 그대로다. */
    previous: Spec | null;
    feedback: Feedback[];
    rejected: unknown;
    schemaErrors: string[];
  }): Promise<unknown>;
}

/** 저장소 포트: 치수 규칙, UI 스타일 목록, 처리 기록, 결과물, 사례 저장소 */
export interface StorePort {
  /** 그 상품 종류의 치수 규칙 */
  dimensionRules(kind: string): Promise<DimensionRule[]>;
  styles(): Promise<Style[]>;
  appendLog(entry: LogEntry): Promise<void>;
  submit(product: string, files: ProductFiles): Promise<void>;
  recordCase(record: CaseRecord): Promise<void>;
}

/** 사람 결정. 시험에서는 각본, 운영에서는 화면이 답한다. */
export interface HumanPort {
  /**
   * 후보 카드(후보와 정면에 따른 축 대응, 업로드한 스윕으로 만든 변형 미리보기, 자식 치수의 부모 후보) 중 하나를 고른다.
   * parents는 고른 카드의 자식 치수마다 움직일 부모다(자식 파라미터 → 부모 파라미터). 부모 후보가 하나뿐이면 적지 않아도 그 부모다.
   */
  chooseCandidate(cards: CandidateCard[]): Promise<{ candidate: string; parents?: Record<string, string> }>;
  finalApproval(review: { spec: Spec; files: ProductFiles }): Promise<{ decision: "approve" }>;
}

export interface PipelineInput {
  bundle: unknown;
  intake: Intake;
  human: HumanPort;
  ports: { fusion: FusionPort; ai: AiPort; store: StorePort };
}

export type PipelineResult = { status: "submitted" } | { status: "stopped"; stage: Stage; reason: string };

/** 형식이 틀린 AI 응답을 다시 묻는 횟수 */
const SCHEMA_RETRIES = 3;

/** 같은 후보로 검증 피드백을 붙여 명세를 다시 쓰는 횟수. 이를 넘으면 후보 제시로 돌아간다. */
const SPEC_RETRIES = 3;

/**
 * 카드와 운영자가 고른 부모로 고른 후보를 만든다. AI 입력과 사례 기록에는 미리보기 그림을 싣지 않는다.
 * 고른 부모가 그 치수의 부모 후보가 아니거나, 두 슬라이더가 같은 부모를 움직이게 되면 오류 문장을 돌려준다.
 */
function chosenOf({ previews: _previews, choices, ...candidate }: CandidateCard, parents: Record<string, string> = {}): ChosenCandidate | string {
  const sliders: ChosenSlider[] = [];
  for (const choice of choices) {
    const picked = pickParent(choice, parents[choice.parameter]);
    if ("error" in picked) return picked.error;
    // 명세의 슬라이더 id는 겹칠 수 없다
    if (sliders.some((s) => s.parent === picked.parent)) return `${picked.parent}를 두 슬라이더가 같이 움직이게 됩니다`;
    sliders.push({ parameter: choice.parameter, name: choice.name, parent: picked.parent });
  }
  return { ...candidate, sliders };
}

class PipelineStop extends Error {
  readonly stage: Stage;
  constructor(stage: Stage, reason: string) {
    super(reason);
    this.stage = stage;
  }
}

export async function runPipeline({ bundle, intake, human, ports }: PipelineInput): Promise<PipelineResult> {
  const { ai, fusion, store } = ports;
  // 형식은 업로드 단계에서 검사한다. 그 뒤로는 업로드 묶음 스키마를 통과한 값이다.
  const uploaded = bundle as UploadBundle;
  const log = (stage: Stage, detail?: unknown) =>
    store.appendLog({ product: intake.name, stage, at: new Date().toISOString(), ...(detail === undefined ? {} : { detail }) });

  /**
   * AI 응답이 스키마를 통과할 때까지 다시 묻는다. 끝내 통과하지 못하면 그 단계에서 멈춘다.
   * 다시 물을 때는 형식 검사에 걸린 응답(rejected)과 그 오류를 붙인다.
   */
  async function askUntilValid<T>(stage: Stage, check: Check, call: (schemaErrors: string[], rejected: unknown) => Promise<unknown>): Promise<T> {
    let errors: string[] = [];
    let rejected: unknown = null;
    for (let attempt = 0; attempt <= SCHEMA_RETRIES; attempt++) {
      const answer = await call(errors, structuredClone(rejected));
      rejected = answer;
      errors = typeof answer === "string" ? [UNREADABLE_ANSWER] : check(answer);
      if (errors.length === 0) return answer as T;
      await log(stage, { schemaErrors: errors });
    }
    throw new PipelineStop(stage, `AI 응답이 ${SCHEMA_RETRIES}번 다시 물어도 형식 검사를 통과하지 못했습니다: ${errors.join("; ")}`);
  }

  /** 같은 요청에는 같은 형상이 오므로, 이 상품을 처리하는 동안 받은 추가 샘플은 다시 요청하지 않는다. */
  const answered = new Map<string, CrossSample[]>();

  /**
   * 애드인에 추가 샘플을 요청한다. 연결이 끊겨 있으면 실패로 세지 않고 "Fusion 연결 필요"로 기다렸다가 다시 요청한다.
   * 애드인이 샘플을 뽑지 못했거나 응답이 형식에 맞지 않으면 검증 단계에서 멈춘다.
   */
  async function requestSamples(request: SampleRequest): Promise<CrossSample[]> {
    const key = JSON.stringify(request);
    const cached = answered.get(key);
    if (cached) return cached;
    for (;;) {
      const answer = await fusion.requestSamples(request);
      if (answer.status === "answered") {
        const errors = checkSampleResponse(answer.response);
        if (errors.length > 0) throw new PipelineStop("verification", `애드인 응답 형식 오류: ${errors.join("; ")}`);
        const { samples } = answer.response as { samples: CrossSample[] };
        // 서버도 같은 검사를 하지만, 포트 구현이 서버를 거치지 않을 수도 있어 여기서 한 번 더 본다.
        if (JSON.stringify(samples.map((s) => s.values)) !== JSON.stringify(request.values)) {
          throw new PipelineStop("verification", "애드인 응답의 값 묶음이 요청과 다릅니다");
        }
        answered.set(key, samples);
        return samples;
      }
      if (answer.status === "failed") throw new PipelineStop("verification", `애드인이 추가 샘플을 뽑지 못했습니다: ${answer.reason}`);
      await log("verification", { fusion: FUSION_NEEDED });
      await fusion.reconnected();
      await log("verification", { fusion: FUSION_RECONNECTED });
    }
  }

  // 명세의 상품명은 정보 입력에서 가져오고, 슬라이더·부품 이름은 업로드 묶음을 가리킨다(docs/spec-schema.md).
  // 슬라이더 범위의 근거는 정보 입력의 상품 종류의 치수 규칙이다. 상품 하나를 처리하는 동안 바뀌지 않는다.
  const rules = await store.dimensionRules(intake.kind);
  const ranges = rangeIntersection({ rules, intake, bundle: uploaded });

  /** 고른 후보 카드를 따르는 명세인지까지 본다 */
  const checkProductSpec = (chosen: ChosenCandidate): Check => (value) => {
    const errors = checkSpec(value);
    if (errors.length > 0) return errors;
    const spec = value as Spec;
    if (spec.product !== intake.name) errors.push(`/product: 정보 입력의 상품명 "${intake.name}"이어야 합니다`);
    errors.push(
      ...specReferenceChecker(uploaded)(spec),
      ...ranges.check(spec),
      ...thicknessChoiceChecker(uploaded)(spec),
      ...fixedThicknessChecker(spec),
      ...chosenCandidateChecker(chosen)(spec),
    );
    return errors;
  };

  const checkBundleParts: Check = (value) => {
    const errors = checkParts(value);
    return errors.length > 0 ? errors : partsReferenceChecker(uploaded)(value as PartsFound);
  };

  // 후보의 부모 파라미터는 업로드 묶음에서 슬라이더로 쓸 수 있는 파라미터여야 한다(개수형 제외).
  // 후보끼리 사실상 같으면 안 되고, 정면은 부품 탐색을, 두께 선택 노출은 정보 입력을 따른다.
  const checkBundleCandidates = (parts: PartsFound): Check => (value) => {
    const errors = checkCandidates(value);
    if (errors.length > 0) return errors;
    return [...candidateReferenceChecker(uploaded)(value as Candidate[]), ...candidateDiversityChecker(parts, intake.thickness)(value as Candidate[])];
  };

  /** 받은 격자 보강. key는 요청한 값 묶음이라, 명세의 범위나 기본값이 바뀌면 그 격자는 쓰지 않는다. */
  interface Reinforcement {
    pair: Pair;
    key: string;
    sweep: GridSweep;
    /** 격자 마디 사이 검증점의 Fusion 형상 */
    checks: CrossSample[];
  }

  const gridKey = (spec: Spec, pair: Pair) => JSON.stringify(gridValues(spec, pair));
  /** 이 명세에 쓸 수 있는 격자: 쌍(두 슬라이더, 또는 두께 선택과 슬라이더)이 명세에 있고, 요청한 값 묶음이 지금 범위·기본값·두께 후보와 같다 */
  const gridsFor = (spec: Spec, reinforcements: Reinforcement[]) =>
    reinforcements.filter((r) => pairInSpec(spec, r.pair) && r.key === gridKey(spec, r.pair));

  /**
   * 조립하고 수치 검증 → 축 반응 → 교차 검증(격자 보강 쌍은 격자 검증점까지)을 차례로 본다. 첫 실패 단계의 피드백과,
   * 교차 검증까지 갔으면 실패한 쌍을 돌려준다.
   */
  async function assembleAndVerify(spec: Spec, grids: Reinforcement[]): Promise<{ files: ProductFiles; feedback: Feedback[]; failedPairs: PairFailure[] }> {
    // 두께 선택이 있으면 두께 후보 형상을 애드인에 받아 결과물에 담는다(ADR-0010). 엔진에 넣을 수 없는 형상이면 재기 전에 돌려준다.
    // 같은 요청은 requestSamples가 다시 보내지 않으므로, 두께 선택과 슬라이더 범위가 그대로인 재작성은 애드인을 부르지 않는다.
    const plan = thicknessSamplePlan(spec, uploaded);
    const thickness = plan.length === 0 ? [] : await requestSamples({ kind: "thickness", values: plan.map((p) => p.values) });
    const files = await assembleProduct(spec, { ...uploaded, grids: grids.map((r) => r.sweep), thickness });
    await log("assembly");
    const thicknessProblems = checkThicknessSamples(plan, thickness);
    if (thicknessProblems.length > 0) return { files, feedback: thicknessProblems, failedPairs: [] };

    // 두께 고정 실측은 녹화된 단독 스윕으로, 수치 검증은 결과물에 담긴 스윕 데이터로 잰다. 통과하면 축 반응을 녹화된 단독 스윕으로 보고,
    // 그것도 통과하면 애드인에 교차 검증 샘플을 받아 슬라이더 덧셈을 본다. AI 판정(티켓 19)이 뒤에 붙는다.
    // 슬라이더가 애드인이 줄인 스윕 범위를 넘으면 엔진이 그 밖을 끝 샘플에 붙이므로, 재기 전에 범위부터 좁히게 한다.
    const sweeps: SweepData = JSON.parse(files["sweeps.json"]);
    let feedback = verifyRange(spec, uploaded);
    // 두께 고정 실측은 수치 검증보다 먼저 본다. 슬라이더가 판 두께를 바꾸면 수치 검증의 판 두께 치수 오차보다
    // "슬라이더 X가 부품 Y의 두께를 바꿈"이 원인을 바로 가리키고, 비율 수식이면 수치 검증은 통과하기 때문이다.
    if (feedback.length === 0) feedback = verifyThicknessFixed(spec, sweeps, uploaded);
    if (feedback.length === 0) feedback = verifyNumeric(spec, sweeps, uploaded);
    if (feedback.length === 0) feedback = verifyAxisResponse(spec, uploaded);
    const crossValues = crossCheckValues(spec);
    if (feedback.length > 0 || crossValues.length === 0) return { files, feedback, failedPairs: [] };

    const samples = await requestSamples({ kind: "cross", values: crossValues });
    const failedPairs = verifyCross(spec, sweeps, uploaded, samples);
    feedback = [...failedPairs.flatMap((f) => f.feedback), ...grids.flatMap((r) => verifyGrid(spec, sweeps, uploaded, r.pair, r.checks))];
    return { files, feedback, failedPairs };
  }

  /**
   * 명세 작성 → 조립 → 검증. 검증 피드백을 붙여 다시 쓰고, 통과하면 명세와 결과물을,
   * SPEC_RETRIES번 넘게 실패하면 마지막 피드백을 돌려준다.
   *
   * 교차 검증에 실패한 쌍은 먼저 피드백으로 명세를 고치게 하고, 다시 쓴 명세에서도 실패하면 그 쌍을 3×3 격자로
   * 보강해 같은 명세를 한 번 더 검증한다(ADR-0008). 격자 보강은 명세가 아니라 결과물의 스윕 데이터에 담긴다.
   */
  async function writeVerifiedSpec(candidate: ChosenCandidate): Promise<{ spec: Spec; files: ProductFiles } | { feedback: Feedback[] }> {
    let feedback: Feedback[] = [];
    /** 검증 피드백을 받은 직전 명세 */
    let previous: Spec | null = null;
    /** 이 후보로 받은 격자 보강 */
    const reinforcements: Reinforcement[] = [];
    /** 앞선 명세에서 교차 검증에 실패해 피드백으로 돌아간 쌍 */
    const pairsFailedBefore: Pair[] = [];

    for (let attempt = 0; attempt <= SPEC_RETRIES; attempt++) {
      const spec: Spec = await askUntilValid("spec", checkProductSpec(candidate), (schemaErrors, rejected) =>
        ai.writeSpec({ bundle, intake, candidate: structuredClone(candidate), rules: structuredClone(rules), previous: structuredClone(previous), feedback, rejected, schemaErrors }),
      );
      previous = spec;
      await log("spec");

      // 범위 교집합이 없으면 범위를 지어내지 않도록 조립하지 않고 돌려준다. 처리 기록으로 운영자에게도 보인다.
      const noIntersection = ranges.noIntersection(spec);
      if (noIntersection.length > 0) {
        feedback = noIntersection;
        await log("verification", { attempt, feedback });
        continue;
      }

      const grids = gridsFor(spec, reinforcements);
      const verified = await assembleAndVerify(spec, grids);
      let files = verified.files;
      feedback = verified.feedback;
      const failedBefore = (pair: Pair) => pairsFailedBefore.some((p) => samePair(p, pair));
      const toReinforce = verified.failedPairs
        .filter((f) => failedBefore(f.pair) && fixableByGrid(f) && !grids.some((r) => samePair(r.pair, f.pair)))
        .map((f) => f.pair);
      pairsFailedBefore.push(...verified.failedPairs.map((f) => f.pair).filter((pair) => !failedBefore(pair)));

      if (toReinforce.length > 0) {
        const needed = [...grids.map((r) => r.pair), ...toReinforce];
        if (needed.length > GRID_PAIR_LIMIT) {
          feedback.push(gridLimitFeedback(needed));
        } else {
          const { added, problems } = await reinforce(spec, toReinforce);
          // 격자를 뽑을 수 있었던 쌍은 다른 쌍이 실패해도 남겨 두고 다음 명세에서 쓴다.
          reinforcements.push(...added);
          if (problems.length > 0) feedback.push(...problems);
          else ({ files, feedback } = await assembleAndVerify(spec, gridsFor(spec, reinforcements)));
        }
      }
      await log("verification", { attempt, feedback });
      if (feedback.length === 0) return { spec, files };
    }
    return { feedback };
  }

  /**
   * 쌍마다 격자와 그 검증점을 애드인에 요청한다. 엔진에 넣을 수 있는 격자는 added로,
   * 넣을 수 없는 격자(재계산 실패·위상 변화)는 그 피드백을 problems로 돌려준다.
   */
  async function reinforce(spec: Spec, pairs: Pair[]): Promise<{ added: Reinforcement[]; problems: Feedback[] }> {
    const added: Reinforcement[] = [];
    const problems: Feedback[] = [];
    for (const pair of pairs) {
      const { grid, checks } = gridValues(spec, pair);
      const samples = await requestSamples({ kind: "grid", values: [...grid, ...checks] });
      const gridSamples = samples.slice(0, grid.length);
      const unusable = checkGridSamples(spec, uploaded, pair, gridSamples);
      if (unusable.length > 0) {
        problems.push(...unusable);
        continue;
      }
      added.push({ pair, key: gridKey(spec, pair), sweep: { parameters: pair, samples: gridSamples }, checks: samples.slice(grid.length) });
      await log("verification", { grid: pair });
    }
    return { added, problems };
  }

  try {
    const bundleErrors = checkUploadBundle(bundle);
    if (bundleErrors.length > 0) throw new PipelineStop("upload", `업로드 묶음 형식 오류: ${bundleErrors.join("; ")}`);
    // 애드인이 범위 끝의 위상 변화로 줄인 스윕 범위. 모델링 오류 의심은 운영자가 모델을 확인할 일이라 처리 기록에 남긴다.
    const rangeFeedback = uploadRangeFeedback(uploaded);
    await log("upload", rangeFeedback.length > 0 ? { feedback: rangeFeedback } : undefined);

    const intakeErrors = checkIntake(intake);
    if (intakeErrors.length > 0) throw new PipelineStop("intake", `정보 입력 형식 오류: ${intakeErrors.join("; ")}`);
    await log("intake", intake);
    // 메모에서 어느 부위에도 붙지 않아 범위로 읽지 못한 "값~값"은 운영자가 의도를 확인하도록 남긴다
    if (ranges.unreadMemo.length > 0) await log("intake", { memoUnread: ranges.unreadMemo });

    // 부품 탐색은 상품마다 한 번이다. 후보 제시로 돌아와도 같은 형상이라 다시 묻지 않는다.
    const { views, colors } = partViews(uploaded);
    const parts = await askUntilValid<PartsFound>("candidates", checkBundleParts, (schemaErrors, rejected) =>
      ai.findParts({ intake, views, colors, rejected, schemaErrors }),
    );

    // 후보 제시로 돌아오는 고리. 회차마다 사람이 후보를 고르므로 사람 없이 끝없이 돌지는 않는다.
    const failures: CandidateFailure[] = [];
    for (;;) {
      const candidates = await askUntilValid<Candidate[]>("candidates", checkBundleCandidates(parts), (schemaErrors, rejected) =>
        ai.proposeCandidates({ bundle, intake, parts: structuredClone(parts), failures: structuredClone(failures), rejected, schemaErrors }),
      );
      await log("candidates", candidates.map((c) => c.id));

      const cards = candidateCards(candidates, uploaded, parts);
      const { candidate: chosenId, parents: chosenParents } = await human.chooseCandidate(cards);
      const card = cards.find((c) => c.id === chosenId);
      if (!card) throw new PipelineStop("choice", `제시되지 않은 후보 ${chosenId}를 골랐습니다`);
      const candidate = chosenOf(card, chosenParents);
      if (typeof candidate === "string") throw new PipelineStop("choice", candidate);
      await log("choice", { candidate: chosenId, parents: Object.fromEntries(candidate.sliders.map((s) => [s.parameter, s.parent])) });

      const styles = await store.styles();
      const { style } = await askUntilValid<{ style: string }>(
        "style",
        styleChoiceChecker(styles.map((s) => s.id)),
        (schemaErrors, rejected) => ai.chooseStyle({ intake, candidate, styles, rejected, schemaErrors }),
      );
      await log("style", style);

      const written = await writeVerifiedSpec(candidate);
      if ("feedback" in written) {
        failures.push({ candidate, feedback: written.feedback });
        continue;
      }
      const { spec, files } = written;

      const { decision } = await human.finalApproval({ spec, files });
      await log("approval", decision);

      await store.submit(intake.name, files);
      await store.recordCase({ kind: intake.kind, intake, candidates, chosen: candidate.id, spec });
      await log("submission");
      return { status: "submitted" };
    }
  } catch (error) {
    if (!(error instanceof PipelineStop)) throw error;
    await log(error.stage, { stopped: error.message });
    return { status: "stopped", stage: error.stage, reason: error.message };
  }
}
