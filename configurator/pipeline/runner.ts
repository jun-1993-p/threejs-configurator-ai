// 파이프라인 실행기: 상품 하나를 10단계 고정 순서로 진행한다(ADR-0014). AI는 단계 안에서 정해진 형식으로만 답한다.
// 바깥 의존은 Fusion 연결·AI 모델·저장소 세 포트로만 접근한다.
import type { Spec, SweepData } from "../src/engine.ts";
import { assembleProduct, type ProductFiles } from "./assemble.ts";
import type { Feedback } from "./feedback.ts";
import { FRONTS, checkCandidates, checkSampleResponse, checkSpec, checkUploadBundle, specReferenceChecker, styleChoiceChecker, type Check } from "./schemas.ts";
import type { UploadBundle } from "./upload-bundle.ts";
import { verifyAxisResponse } from "./verify-axis.ts";
import { crossCheckValues, verifyCross, type CrossSample } from "./verify-cross.ts";
import { verifyNumeric } from "./verify-numeric.ts";

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
  kind: string;
  /** 원하는 슬라이더와 범위 메모(자유 문장) */
  memo: string;
  /** 두께 선택 노출 여부. ai는 "AI 판단" */
  thickness: "show" | "hide" | "ai";
}

export type Front = (typeof FRONTS)[number];

/** 슬라이더 구성 후보 */
export interface Candidate {
  id: string;
  front: Front;
  /** 노출할 부모 파라미터 */
  parents: string[];
  showThickness: boolean;
  summary: string;
  /** 다른 후보와의 차이 한 줄 */
  diff: string;
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

/**
 * AI 모델 포트. 응답은 검사 전이라 unknown이다. 실행기가 JSON Schema로 검사하고,
 * 형식이 틀리면 schemaErrors를 붙여 다시 묻는다.
 */
export interface AiPort {
  proposeCandidates(input: {
    bundle: unknown;
    intake: Intake;
    failures: CandidateFailure[];
    schemaErrors: string[];
  }): Promise<unknown>;
  chooseStyle(input: { intake: Intake; candidate: Candidate; styles: Style[]; schemaErrors: string[] }): Promise<unknown>;
  writeSpec(input: {
    bundle: unknown;
    intake: Intake;
    candidate: Candidate;
    feedback: Feedback[];
    schemaErrors: string[];
  }): Promise<unknown>;
}

/** 저장소 포트: UI 스타일 목록, 처리 기록, 결과물, 사례 저장소 */
export interface StorePort {
  styles(): Promise<Style[]>;
  appendLog(entry: LogEntry): Promise<void>;
  submit(product: string, files: ProductFiles): Promise<void>;
  recordCase(record: CaseRecord): Promise<void>;
}

/** 사람 결정. 시험에서는 각본, 운영에서는 화면이 답한다. */
export interface HumanPort {
  chooseCandidate(candidates: Candidate[]): Promise<{ candidate: string }>;
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

class PipelineStop extends Error {
  readonly stage: Stage;
  constructor(stage: Stage, reason: string) {
    super(reason);
    this.stage = stage;
  }
}

export async function runPipeline({ bundle, intake, human, ports }: PipelineInput): Promise<PipelineResult> {
  const { ai, fusion, store } = ports;
  const log = (stage: Stage, detail?: unknown) =>
    store.appendLog({ product: intake.name, stage, at: new Date().toISOString(), ...(detail === undefined ? {} : { detail }) });

  /** AI 응답이 스키마를 통과할 때까지 다시 묻는다. 끝내 통과하지 못하면 그 단계에서 멈춘다. */
  async function askUntilValid<T>(stage: Stage, check: Check, call: (schemaErrors: string[]) => Promise<unknown>): Promise<T> {
    let errors: string[] = [];
    for (let attempt = 0; attempt <= SCHEMA_RETRIES; attempt++) {
      const answer = await call(errors);
      errors = check(answer);
      if (errors.length === 0) return answer as T;
      await log(stage, { schemaErrors: errors });
    }
    throw new PipelineStop(stage, `AI 응답이 ${SCHEMA_RETRIES}번 다시 물어도 형식 검사를 통과하지 못했습니다: ${errors.join("; ")}`);
  }

  /**
   * 애드인에 추가 샘플을 요청한다. 연결이 끊겨 있으면 실패로 세지 않고 "Fusion 연결 필요"로 기다렸다가 다시 요청한다.
   * 애드인이 샘플을 뽑지 못했거나 응답이 형식에 맞지 않으면 검증 단계에서 멈춘다.
   */
  async function requestSamples(request: SampleRequest): Promise<CrossSample[]> {
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
        return samples;
      }
      if (answer.status === "failed") throw new PipelineStop("verification", `애드인이 추가 샘플을 뽑지 못했습니다: ${answer.reason}`);
      await log("verification", { fusion: FUSION_NEEDED });
      await fusion.reconnected();
      await log("verification", { fusion: FUSION_RECONNECTED });
    }
  }

  /** 슬라이더 쌍마다 모서리 조합 교차 검증. 슬라이더가 하나면 요청하지 않는다. */
  async function verifyCrossChecks(spec: Spec, sweeps: SweepData): Promise<Feedback[]> {
    const values = crossCheckValues(spec);
    if (values.length === 0) return [];
    const samples = await requestSamples({ kind: "cross", values });
    return verifyCross(spec, sweeps, bundle as UploadBundle, samples);
  }

  // 명세의 상품명은 정보 입력에서 가져오고, 슬라이더·부품 이름은 업로드 묶음을 가리킨다(docs/spec-schema.md).
  const checkProductSpec: Check = (value) => {
    const errors = checkSpec(value);
    if (errors.length > 0) return errors;
    const spec = value as Spec;
    if (spec.product !== intake.name) errors.push(`/product: 정보 입력의 상품명 "${intake.name}"이어야 합니다`);
    errors.push(...specReferenceChecker(bundle as UploadBundle)(spec));
    return errors;
  };

  /**
   * 명세 작성 → 조립 → 검증. 검증 피드백을 붙여 다시 쓰고, 통과하면 명세와 결과물을,
   * SPEC_RETRIES번 넘게 실패하면 마지막 피드백을 돌려준다.
   */
  async function writeVerifiedSpec(candidate: Candidate): Promise<{ spec: Spec; files: ProductFiles } | { feedback: Feedback[] }> {
    let feedback: Feedback[] = [];
    for (let attempt = 0; attempt <= SPEC_RETRIES; attempt++) {
      const spec = await askUntilValid<Spec>("spec", checkProductSpec, (schemaErrors) =>
        ai.writeSpec({ bundle, intake, candidate, feedback, schemaErrors }),
      );
      await log("spec");

      // 업로드 단계에서 스키마를 통과했으므로 엔진이 읽는 스윕 데이터 형식이다.
      const files = await assembleProduct(spec, bundle as SweepData);
      await log("assembly");

      // 수치 검증은 결과물에 담긴 스윕 데이터로 잰다. 통과하면 축 반응을 녹화된 단독 스윕으로 보고,
      // 그것도 통과하면 애드인에 교차 검증 샘플을 받아 슬라이더 덧셈을 본다. AI 판정(티켓 19)이 뒤에 붙는다.
      const sweeps: SweepData = JSON.parse(files["sweeps.json"]);
      feedback = verifyNumeric(spec, sweeps, bundle as UploadBundle);
      if (feedback.length === 0) feedback = verifyAxisResponse(spec, bundle as UploadBundle);
      if (feedback.length === 0) feedback = await verifyCrossChecks(spec, sweeps);
      await log("verification", { attempt, feedback });
      if (feedback.length === 0) return { spec, files };
    }
    return { feedback };
  }

  try {
    const bundleErrors = checkUploadBundle(bundle);
    if (bundleErrors.length > 0) throw new PipelineStop("upload", `업로드 묶음 형식 오류: ${bundleErrors.join("; ")}`);
    await log("upload");

    await log("intake", intake);

    // 후보 제시로 돌아오는 고리. 회차마다 사람이 후보를 고르므로 사람 없이 끝없이 돌지는 않는다.
    const failures: CandidateFailure[] = [];
    for (;;) {
      const candidates = await askUntilValid<Candidate[]>("candidates", checkCandidates, (schemaErrors) =>
        ai.proposeCandidates({ bundle, intake, failures: structuredClone(failures), schemaErrors }),
      );
      await log("candidates", candidates.map((c) => c.id));

      const { candidate: chosenId } = await human.chooseCandidate(candidates);
      const candidate = candidates.find((c) => c.id === chosenId);
      if (!candidate) throw new PipelineStop("choice", `제시되지 않은 후보 ${chosenId}를 골랐습니다`);
      await log("choice", chosenId);

      const styles = await store.styles();
      const { style } = await askUntilValid<{ style: string }>(
        "style",
        styleChoiceChecker(styles.map((s) => s.id)),
        (schemaErrors) => ai.chooseStyle({ intake, candidate, styles, schemaErrors }),
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
