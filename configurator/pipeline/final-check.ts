// 최종 확인(사용자 스토리 83~85): 개발 뒤 처음 보는 상품마다 실제 파이프라인을 돌리고, 처리 기록으로
// 후보 선택·최종 승인 밖의 사람 개입을 찾아 통과를 판정한다. 실패는 명세 문제와 엔진 한계로 나눈다.
import { createHash } from "node:crypto";

import type { Feedback, FeedbackKind } from "./feedback.ts";
import type { FailureClass, VerdictStatus } from "./schemas.ts";
import { AI_FORMAT_FAILURE, type ApprovalDecision, type LogEntry, type PipelineResult } from "./runner.ts";
import type { UploadBundle } from "./upload-bundle.ts";

export interface ProductOutcome {
  /** 후보 선택과 최종 승인만으로 끝났다(슬라이더 이름 고치기는 허용) */
  passed: boolean;
  /** 후보 선택·최종 승인 밖의 사람 개입 */
  interventions: string[];
  /** 통과하지 못한 까닭과 그 근거 */
  failure: { class: FailureClass; evidence: string[] } | null;
}

/**
 * 명세를 고쳐도 없어지지 않는 검증 피드백 종류: 변형 엔진이 Fusion 형상을 따라가지 못했다.
 * 적응형 스윕(ADR-0007)과 격자 보강(ADR-0008)을 거친 뒤의 형상·치수 오차, 섞을 수 없는 위상 변화, 상한을 넘은 위상 묶음·격자 보강 쌍이다.
 * 나머지(축 반응, 범위, 두께 선택, AI 판정 등)는 명세의 선언이나 범위를 고치면 되는 명세 문제다.
 */
export const ENGINE_LIMIT_KINDS: readonly FeedbackKind[] = ["shape_error", "dimension_error", "topology_change", "topology_group_limit", "grid_limit"];

/**
 * 처리 기록의 사람 결정을 읽어 후보 선택·최종 승인 밖의 개입을 찾는다. 통과하지 못했으면 개입 바로 앞 검증의 피드백으로
 * 명세 문제와 엔진 한계를 나눈다. 같은 후보 안에서 검증 피드백으로 명세를 고쳐 통과한 것은 자동 진행이라 개입이 아니다.
 */
export function judgeRun(log: LogEntry[], result: PipelineResult): ProductOutcome {
  const interventions: string[] = [];
  const evidence: string[] = [];
  let engineLimit = false;
  /** 마지막 검증의 피드백 */
  let lastFeedback: Feedback[] = [];
  let proposals = 0;
  /** 최종 승인에서 거절 이유로 후보 제시를 다시 하게 했다 */
  let rejectedForCandidates = false;

  /** 마지막 검증의 피드백을 근거로 붙이고, 엔진 한계 종류가 있으면 엔진 한계로 본다 */
  const weighLastFeedback = () => {
    evidence.push(...lastFeedback.map((f) => `${f.kind}: 슬라이더 ${f.slider}, 부품 ${f.part}`));
    engineLimit ||= lastFeedback.some((f) => ENGINE_LIMIT_KINDS.includes(f.kind));
  };
  const intervene = (what: string) => {
    interventions.push(what);
    evidence.push(what);
    weighLastFeedback();
  };

  for (const { stage, detail } of log) {
    if (stage === "verification" && hasFeedback(detail)) lastFeedback = detail.feedback;
    if (stage === "candidates" && Array.isArray(detail)) {
      // 첫 후보 제시 뒤로는, 거절 이유로 다시 받은 것이 아니면 같은 후보로 검증을 통과하지 못해 돌아온 것이다
      if (proposals++ > 0 && !rejectedForCandidates) intervene("같은 후보로 검증을 통과하지 못해 후보를 다시 골랐다");
      rejectedForCandidates = false;
    }
    if (stage !== "approval" || !isDecision(detail)) continue;
    if (detail.decision === "reject") {
      if (detail.back === "choice") intervene("최종 승인에서 반려하고 다른 후보를 골랐다");
      else intervene(`최종 승인에서 반려하고 후보를 다시 받았다: ${detail.reason}`);
      rejectedForCandidates = detail.back === "candidates";
      continue;
    }
    // 슬라이더 이름 고치기만 허용한다(사용자 스토리 84)
    for (const [id, edit] of Object.entries(detail.edits ?? {})) {
      if (edit.min !== undefined || edit.max !== undefined) intervene(`최종 승인에서 ${id}의 범위를 고쳤다`);
    }
  }
  if (result.status === "stopped") {
    // 후보 제시 단계에서 멈춘 것(후보 하나뿐인 구성, 회차 상한)은 후보 제시로 돌아가려다 멈춘 것이라, 돌아간 경우처럼 마지막 시도로 가린다
    if (result.stage === "candidates") weighLastFeedback();
    evidence.push(`${result.stage} 단계에서 멈췄다: ${result.reason}`);
    // 업로드 묶음을 읽지 못했거나 애드인이 추가 샘플을 주지 못한 것은 고정된 코드 쪽 한계다. AI 응답 형식은 명세를 쓰는 쪽 문제다.
    engineLimit ||= (result.stage === "upload" || result.stage === "verification") && !result.reason.startsWith(AI_FORMAT_FAILURE);
  }
  const passed = result.status === "submitted" && interventions.length === 0;
  return { passed, interventions, failure: passed ? null : { class: engineLimit ? "engine" : "spec", evidence: [...new Set(evidence)] } };
}

/** 처음 보는 상품이라는 기록: 모델 지문과, 견준 개발 중 녹화본 수와 지문이 같은 녹화본 */
export interface UnseenEvidence {
  fingerprint: string;
  compared: number;
  matches: string[];
}

/**
 * 모델 지문: 파라미터 이름(개수형 여부와 함께)과 부품 이름. 값과 수식은 넣지 않는다. 사용자 파라미터의 수식은 곧 기본값이라,
 * 개발 중 모델의 기본값만 바꿔 다시 올린 상품도 같은 모델로 잡기 위해서다. 점 좌표도 다시 올릴 때마다 조금씩 다르다.
 */
function fingerprint(bundle: UploadBundle): string {
  const parameters = bundle.parameters.map((p) => `${p.name}${p.is_count ? "#" : ""}`).sort();
  const parts = bundle.parts.map((p) => p.name).sort();
  return createHash("sha256").update(JSON.stringify({ parameters, parts })).digest("hex");
}

/** 개발 중 녹화본: 시험 데이터로 쓴 업로드 묶음과 그 저장소 경로 */
export interface Recording {
  path: string;
  bundle: UploadBundle;
}

/** 개발 중 녹화본과 지문을 견준다. 겹치는 녹화본이 있으면 처음 보는 상품이 아니다(spec.md 최종 확인). */
export function unseenEvidence(bundle: UploadBundle, recordings: Recording[]): UnseenEvidence {
  const mine = fingerprint(bundle);
  return { fingerprint: mine, compared: recordings.length, matches: recordings.filter((r) => fingerprint(r.bundle) === mine).map((r) => r.path) };
}

/** 최종 확인에서 상품 하나를 돌린 기록 */
export interface ProductRecord {
  /** 최종 확인 상품 목록의 id */
  id: string;
  at: string;
  /** 돌릴 때 고정 코어·변형 엔진(configurator/src)의 git 트리 해시 */
  core: string;
  unseen: UnseenEvidence;
  result: PipelineResult;
  outcome: ProductOutcome;
}

/** 10개 중 8개(사용자 스토리 84). 상품 수가 10개가 아니면 같은 비율로 본다. */
export const PASS_RATIO = 0.8;

export interface FinalVerdict {
  status: VerdictStatus;
  passed: number;
  total: number;
  /** 아직 돌리지 않은 상품 */
  missing: string[];
  /** 판정을 무효로 만든 까닭 */
  problems: string[];
}

/** 상품 목록 전부를 시작할 때와 같은 고정 코어·변형 엔진으로 돌렸을 때만 통과·불통과를 낸다 */
export function finalVerdict({ products, core, records }: { products: string[]; core: string; records: ProductRecord[] }): FinalVerdict {
  const problems = records.flatMap((r) => [
    ...(r.core === core ? [] : [`${r.id}: 고정 코어·변형 엔진이 최종 확인을 시작할 때와 다르다(${r.core}, 시작 ${core})`]),
    ...(r.unseen.matches.length === 0 ? [] : [`${r.id}: 개발 중 녹화본과 같은 모델이다(${r.unseen.matches.join(", ")})`]),
  ]);
  const missing = products.filter((id) => !records.some((r) => r.id === id));
  const passed = records.filter((r) => r.outcome.passed).length;
  const total = products.length;
  const status = problems.length > 0 ? "invalid" : missing.length > 0 ? "running" : passed >= PASS_RATIO * total ? "passed" : "failed";
  return { status, passed, total, missing, problems };
}

const hasFeedback = (detail: unknown): detail is { feedback: Feedback[] } => typeof detail === "object" && detail !== null && "feedback" in detail;

/** 처리 기록 approval 단계에는 사람 결정과, 막힌 결정의 오류({ errors })가 남는다 */
const isDecision = (detail: unknown): detail is ApprovalDecision => typeof detail === "object" && detail !== null && "decision" in detail;
