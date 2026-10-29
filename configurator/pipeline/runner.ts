// 파이프라인 실행기: 상품 하나를 10단계 고정 순서로 진행한다(ADR-0014). AI는 단계 안에서 정해진 형식으로만 답한다.
// 바깥 의존은 Fusion 연결·AI 모델·저장소 세 포트로만 접근한다.
import type { Spec, SweepData } from "../src/engine.ts";
import { assembleProduct, type ProductFiles } from "./assemble.ts";
import { FRONTS, checkCandidates, checkSpec, checkUploadBundle, styleChoiceChecker, type Check } from "./schemas.ts";

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

/** 검증 피드백 한 항목. 형식은 docs/spec-schema.md */
export interface Feedback {
  path: string;
  slider: string;
  part: string;
  kind: string;
  measured: unknown;
  expected: unknown;
  hint: string;
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

export interface FusionPort {
  requestSamples(request: SampleRequest): Promise<unknown>;
}

/**
 * AI 모델 포트. 응답은 검사 전이라 unknown이다. 실행기가 JSON Schema로 검사하고,
 * 형식이 틀리면 schemaErrors를 붙여 다시 묻는다.
 */
export interface AiPort {
  proposeCandidates(input: { bundle: unknown; intake: Intake; schemaErrors: string[] }): Promise<unknown>;
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

class PipelineStop extends Error {
  readonly stage: Stage;
  constructor(stage: Stage, reason: string) {
    super(reason);
    this.stage = stage;
  }
}

export async function runPipeline({ bundle, intake, human, ports }: PipelineInput): Promise<PipelineResult> {
  const { ai, store } = ports;
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

  try {
    const bundleErrors = checkUploadBundle(bundle);
    if (bundleErrors.length > 0) throw new PipelineStop("upload", `업로드 묶음 형식 오류: ${bundleErrors.join("; ")}`);
    await log("upload");

    await log("intake", intake);

    const candidates = await askUntilValid<Candidate[]>("candidates", checkCandidates, (schemaErrors) =>
      ai.proposeCandidates({ bundle, intake, schemaErrors }),
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

    // 명세의 상품명은 정보 입력에서 가져온다(docs/spec-schema.md).
    const checkProductSpec: Check = (value) => {
      const errors = checkSpec(value);
      if (errors.length === 0 && (value as Spec).product !== intake.name) {
        errors.push(`/product: 정보 입력의 상품명 "${intake.name}"이어야 합니다`);
      }
      return errors;
    };
    const spec = await askUntilValid<Spec>("spec", checkProductSpec, (schemaErrors) =>
      ai.writeSpec({ bundle, intake, candidate, feedback: [], schemaErrors }),
    );
    await log("spec");

    // 업로드 단계에서 스키마를 통과했으므로 엔진이 읽는 스윕 데이터 형식이다.
    const files = await assembleProduct(spec, bundle as SweepData);
    await log("assembly");

    // 수치 검증(티켓 04), 축 반응 검증(티켓 06), AI 판정(티켓 19)이 여기에 들어온다.
    const feedback: Feedback[] = [];
    await log("verification", { feedback });

    const { decision } = await human.finalApproval({ spec, files });
    await log("approval", decision);

    await store.submit(intake.name, files);
    await store.recordCase({ kind: intake.kind, intake, candidates, chosen: candidate.id, spec });
    await log("submission");
    return { status: "submitted" };
  } catch (error) {
    if (!(error instanceof PipelineStop)) throw error;
    await log(error.stage, { stopped: error.message });
    return { status: "stopped", stage: error.stage, reason: error.message };
  }
}
