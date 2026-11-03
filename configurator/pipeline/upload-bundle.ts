// 업로드 묶음(schema/upload-bundle.schema.json)에서 파이프라인이 읽는 부분의 타입.
import type { SweepData, TopologyGroup, Vector } from "../src/engine.ts";
import type { FeedbackKind } from "./feedback.ts";

/** 면의 표면. 평면은 법선, 원기둥은 원점·축·반지름. 스키마상 평면·원기둥 면에는 꼭 있다. */
export type Geometry = { type: "plane"; normal: Vector } | { type: "cylinder"; origin: Vector; axis: Vector; radius: number };

type EngineSweep = SweepData["sweeps"][number];
type Faces = SweepData["baseline"]["faces"];

/** 바디 안의 면 또는 모서리 이름 */
export interface ShapeRef {
  body: string;
  name: string;
}

/** 범위 끝 쪽에서 재계산이 실패하거나 면 구성이 바뀌거나 위상 묶음이 상한을 넘어 애드인이 스윕 범위를 줄인 기록(ADR-0005) */
export interface Reduction {
  side: "min" | "max";
  /** 기본값에서 그쪽으로 가며 면 구성이 처음 바뀌거나 재계산이 처음 실패한 값. topology_group_limit이면 뺀 묶음에서 기본값에 가장 가까운 점이다. */
  at: number;
  /**
   * 검증 피드백 종류와 같다. range_shrunk: 개수형 파라미터 값도 바뀌었다(위상 묶음 안 단독 스윕).
   * modeling_error_suspected: 개수형 값은 그대로다. topology_group_limit: 위상 묶음이 상한을 넘었다. recompute_failed: 재계산에 실패했다.
   */
  reason: "range_shrunk" | "modeling_error_suspected" | "topology_group_limit" | "recompute_failed";
  removed_faces: ShapeRef[];
  added_faces: ShapeRef[];
  removed_edges: ShapeRef[];
  added_edges: ShapeRef[];
  /** 값이 바뀐 개수형 파라미터: [바로 안쪽 묶음의 값, 그 지점 값] */
  counts: Record<string, [number, number]>;
}

/** 보간 실패(ADR-0007): 적응형 샘플을 17점까지 늘려도 합격선을 넘은 검증점 중 오차 / 합격선이 가장 큰 것 */
export interface InterpolationFailure {
  at: number;
  kind: Extract<FeedbackKind, "shape_error" | "dimension_error">;
  part: string;
  error: number;
  tolerance: number;
}

/** 샘플의 바디별 측정값. SolidCraft 합성 녹화본에만 있다. */
export interface BodyMeasure {
  name: string;
  volume: number;
  bbox: { min: Vector; max: Vector };
}

type BundleSample = EngineSweep["samples"][number] & { bodies?: BodyMeasure[] };

/** 엔진의 단독 스윕에 검증점(이웃 샘플 사이 가운데 값의 형상), 스윕 범위와 그 축소 기록, 보간 실패를 더한 것 */
export interface BundleSweep extends Omit<EngineSweep, "groups"> {
  samples: BundleSample[];
  range: { min: number; max: number };
  checks: BundleSample[];
  reductions?: Reduction[];
  interpolation_failure?: InterpolationFailure;
}

/** 면 표면이 붙은 기준 형상 */
type BundleBaseline = { faces: (Faces[number] & { geometry?: Geometry })[] };

/** 위상 묶음: 기준 형상에 면 표면이, 묶음 안 단독 스윕에 검증점과 범위가 붙는다 */
export interface BundleGroup extends Omit<TopologyGroup, "baseline" | "sweeps"> {
  baseline: BundleBaseline;
  sweeps: BundleSweep[];
}

/** 엔진의 스윕 데이터에 파라미터, 면 표면, 검증점, 스윕 범위와 그 축소 기록을 더한 것 */
export interface UploadBundle extends SweepData {
  parameters: { name: string; value: number; expression: string; is_count: boolean }[];
  baseline: BundleBaseline;
  sweeps: (BundleSweep & { groups?: BundleGroup[] })[];
}
