// 검증 피드백: 검증에 실패한 항목마다 하나씩 AI에게 돌려주는 기록. 형식은 docs/spec-schema.md.

/** 실패 종류. 목록은 docs/spec-schema.md의 검증 피드백 kind와 같다. */
export const FEEDBACK_KINDS = [
  "dimension_error",
  "shape_error",
  "unexpected_shape_change",
  "off_axis_change",
  "missing_axis_change",
  "unexpected_move",
  "thickness_change",
  "topology_change",
  "recompute_failed",
  "range_shrunk",
  "modeling_error_suspected",
  "volume_jump",
  "no_range_intersection",
  "ai_judgment",
  "grid_limit",
] as const;

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface Feedback {
  /** 고칠 명세 위치 */
  path: string;
  slider: string;
  part: string;
  kind: FeedbackKind;
  measured: unknown;
  expected: unknown;
  /** 규칙으로 만든 힌트(AI가 쓰지 않음) */
  hint: string;
}
