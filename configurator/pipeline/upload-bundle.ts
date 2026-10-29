// 업로드 묶음(schema/upload-bundle.schema.json)에서 파이프라인이 읽는 부분의 타입.
import type { SweepData, Vector } from "../src/engine.ts";

/** 면의 표면. 평면은 법선, 원기둥은 원점·축·반지름. 스키마상 평면·원기둥 면에는 꼭 있다. */
export type Geometry = { type: "plane"; normal: Vector } | { type: "cylinder"; origin: Vector; axis: Vector; radius: number };

type Sweep = SweepData["sweeps"][number];

/** 엔진의 스윕 데이터에 면 표면과 검증점(이웃 샘플 사이 가운데 값의 형상)을 더한 것 */
export interface UploadBundle extends SweepData {
  baseline: { faces: (SweepData["baseline"]["faces"][number] & { geometry?: Geometry })[] };
  sweeps: (Sweep & { checks: Sweep["samples"] })[];
}
