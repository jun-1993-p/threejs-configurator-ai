// 수치 검증: 슬라이더 범위 안의 검증점마다 변형 엔진 결과와 녹화된 Fusion 형상을 비교한다(ADR-0012).
// 검증기는 구성기와 같은 변형 엔진(src/engine.ts)을 그대로 불러, 실제로 내보낼 결과를 잰다.
import { createMorph, faceKey, reaches, type Axis, type MorphFace, type SampleFace, type Slider, type Spec, type SweepData, type Topology, type Vector } from "../src/engine.ts";
import type { Feedback } from "./feedback.ts";
import { boundsOf, coordinateOf, diagonal, DIMENSIONS, round, type Bounds } from "./measure.ts";
import type { Geometry, UploadBundle } from "./upload-bundle.ts";

/** 부품 치수(W·D·H와 두께) 오차의 합격선, mm */
export const DIMENSION_TOLERANCE = 0.2;

/** 형상 오차의 합격선: 1 mm와 그 검증점 Fusion 형상(상품 전체) 바운딩 박스 대각선의 0.1% 중 큰 값 */
export const shapeTolerance = (diagonal: number) => Math.max(1, diagonal * 0.001);

/** 판재 두께로 보는 맞선 두 평면의 최대 간격: 표준 두께 목록의 가장 두꺼운 값, mm */
const MAX_THICKNESS = 30;

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 한 형상에서 잰 부품의 실패. path·slider는 부르는 쪽이 채운다. */
export type PartFailure = Omit<Feedback, "path" | "slider">;

/** 비교하는 형상이 어느 슬라이더 값인지와 피드백에 붙일 말 */
export interface ComparisonContext {
  /** measured 앞에 그대로 붙는다(예: { value } 또는 { values }) */
  measured: object;
  /** 힌트에 쓰는 자리(예: "825", "body_w=800·body_h=1000") */
  place: string;
  /** 고치는 방법을 알리는 힌트 꼬리 */
  hintTail: string;
}

/** 한 형상에서 같은 부품을 엔진과 Fusion으로 잰 결과를 비교하는 데 필요한 것 */
interface PartReading extends ComparisonContext {
  part: string;
  faces: MorphFace[];
  engine: Float64Array;
  fusion: Float64Array;
}

/**
 * 슬라이더 값 묶음에서 변형 엔진 결과와 녹화된 Fusion 형상을 부품마다 비교한다. 검증점과 교차 검증 샘플이 같이 쓴다.
 * 엔진은 값이 든 위상 묶음의 면 구성을 내고(ADR-0005), 녹화된 면 구성이 그와 다르면 undefined다.
 */
export type ShapeComparer = (values: Record<string, number>, faces: SampleFace[], context: ComparisonContext) => PartFailure[] | undefined;

export function shapeComparer(spec: Spec, sweeps: SweepData, bundle: UploadBundle): ShapeComparer {
  const morph = createMorph(spec, sweeps);
  const geometry = surfaces(bundle);
  // 판재 두께를 재는 면 쌍은 위상 묶음마다 그 기준 형상에서 한 번 정한다
  const panels = new Map<MorphFace[], PanelPair[]>();
  return (values, faces, context) => {
    const shape = morph.shape(values);
    const fusion = recordedPositions(shape, faces);
    if (!fusion) return undefined;
    if (!panels.has(shape.faces)) panels.set(shape.faces, panelPairs(shape, geometry));
    const tolerance = shapeTolerance(diagonal(bounds(shape.faces, fusion)));
    return [...new Set(shape.faces.map((f) => f.part))].flatMap((part) => {
      const reading: PartReading = { part, faces: shape.faces.filter((f) => f.part === part), engine: shape.positions, fusion, ...context };
      return [...shapeFailures(reading, tolerance), ...sizeFailures(reading, spec), ...thicknessFailures(reading, panels.get(shape.faces)!)];
    });
  };
}

/** 면 표면: 기본 형상과 위상 묶음 기준 형상의 면, (바디, 이름)으로 찾는다 */
function surfaces(bundle: UploadBundle): Map<string, Geometry> {
  const faces = [bundle.baseline.faces, ...bundle.sweeps.flatMap((s) => (s.groups ?? []).map((g) => g.baseline.faces))].flat();
  return new Map(faces.flatMap((f) => (f.geometry ? [[faceKey(f), f.geometry] as const] : [])));
}

/**
 * 검증점에서 합격선을 넘은 항목을 검증 피드백으로 돌려준다. 통과하면 빈 목록이다.
 * sweeps: 결과물에 담긴 스윕 데이터(엔진 입력), bundle: 검증점 형상이 든 업로드 묶음.
 * 위상 묶음이 있는 슬라이더는 묶음마다 나머지 슬라이더의 단독 스윕 검증점도 잰다(그 슬라이더는 묶음 기준 값에 둔다).
 */
export function verifyNumeric(spec: Spec, sweeps: SweepData, bundle: UploadBundle): Feedback[] {
  const compare = shapeComparer(spec, sweeps, bundle);
  // 격자 보강 쌍의 슬라이더는 단독 스윕 검증점을 재지 않는다. 짝 슬라이더가 Fusion 수식으로 따라가는 단독 스윕은
  // 짝 슬라이더 값을 고정한 구성기 상태가 아니기 때문이다. 이 쌍은 교차 검증에서 격자 칸 가운데로 잰다.
  const gridded = new Set((sweeps.grids ?? []).flatMap((g) => g.parameters));
  const sweepOf = (slider: Slider) => bundle.sweeps.find((s) => s.parameter === slider.id);

  /** 슬라이더 하나의 단독 스윕 검증점. fixed는 함께 고정한 다른 슬라이더 값(위상 묶음 기준 값)이다. */
  const checkSweep = (i: number, checks: Check[], fixed: Record<string, number>) => {
    const slider = spec.sliders[i];
    const at = Object.entries(fixed).map(([id, v]) => `·${id}=${v}`).join("");
    return checks
      .filter((c) => c.value >= slider.min && c.value <= slider.max)
      .flatMap((check): Feedback[] => {
        // 범위 끝 쪽을 좁히라고 알린다. 검증점은 샘플 사이 값이라 기본값(샘플)과 같을 수 없다.
        const side = check.value < slider.default ? "min" : "max";
        const narrow = `${slider.id}의 ${side}를 ${check.value}${side === "max" ? "보다 작게" : "보다 크게"} 좁히세요`;
        const values = { [slider.id]: check.value, ...fixed };
        const measured = at ? { values } : { value: check.value };
        const place = at ? `${slider.id}=${check.value}${at}` : String(check.value);
        const fail = (failure: PartFailure): Feedback => ({ path: `sliders[${i}].${side}`, slider: slider.id, ...failure });

        // 부품과 무관한 실패는 part를 비워 둔다.
        if (check.status !== "ok") {
          return [fail({ part: "", kind: "recompute_failed", measured, expected: "재계산 성공", hint: `Fusion이 ${place}에서 재계산하지 못합니다. ${narrow}` })];
        }
        const failures = compare(values, check.faces, { measured, place, hintTail: narrow });
        if (!failures) {
          return [fail({ part: "", kind: "topology_change", measured, expected: "위상 묶음 기준 형상과 같은 면 구성", hint: `${place}에서 면 구성이 그 위상 묶음의 기준 형상과 다릅니다. ${narrow}` })];
        }
        return failures.map(fail);
      });
  };

  return spec.sliders.flatMap((slider, i) => {
    const own = gridded.has(slider.id) ? [] : checkSweep(i, sweepOf(slider)?.checks ?? [], {});
    // 슬라이더 범위가 닿는 위상 묶음마다, 그 묶음 안 단독 스윕의 검증점
    const groups = (sweepOf(slider)?.groups ?? []).filter((g) => reaches(slider, g));
    const inGroups = groups.flatMap((group) =>
      spec.sliders.flatMap((other, j) => {
        if (j === i || gridded.has(other.id)) return [];
        const checks = group.sweeps.find((s) => s.parameter === other.id)?.checks ?? [];
        return checkSweep(j, checks, { [slider.id]: group.anchor });
      }),
    );
    return [...own, ...inGroups];
  });
}

type Check = UploadBundle["sweeps"][number]["checks"][number];

/** 형상 오차: 부품에서 같은 꼭짓점끼리 잰 거리의 최댓값 */
function shapeFailures({ part, measured, place, faces, engine, fusion, hintTail }: PartReading, tolerance: number): PartFailure[] {
  const error = maxDistance(faces, engine, fusion);
  if (error <= tolerance) return [];
  return [
    {
      part,
      kind: "shape_error",
      measured: { ...measured, error_mm: round(error) },
      expected: { max_error_mm: round(tolerance) },
      hint: `${part}의 꼭짓점이 ${place}에서 Fusion과 최대 ${round(error)} mm 어긋납니다. ${hintTail}`,
    },
  ];
}

/** 치수 오차 하나. dimension은 W·D·H 또는 thickness, label은 힌트에 쓰는 이름이다. */
function dimensionFailure(
  { part, measured, place, hintTail }: PartReading,
  dimension: Axis | "thickness",
  label: string,
  engineMm: number,
  fusionMm: number,
  extra: object = {},
): PartFailure[] {
  const error = Math.abs(engineMm - fusionMm);
  if (error <= DIMENSION_TOLERANCE) return [];
  return [
    {
      part,
      kind: "dimension_error",
      measured: { ...measured, dimension, ...extra, engine_mm: round(engineMm), fusion_mm: round(fusionMm), error_mm: round(error) },
      expected: { max_error_mm: DIMENSION_TOLERANCE },
      hint: `${part}의 ${label}가 ${place}에서 Fusion과 ${round(error)} mm 다릅니다. ${hintTail}`,
    },
  ];
}

/** 부품의 W·D·H: 명세의 축 대응에 따른 Fusion 축 방향 바운딩 박스 길이 */
function sizeFailures(reading: PartReading, spec: Spec): PartFailure[] {
  const engineBox = bounds(reading.faces, reading.engine);
  const fusionBox = bounds(reading.faces, reading.fusion);
  return DIMENSIONS.flatMap((dimension) => {
    const c = coordinateOf(spec.axes, dimension);
    return dimensionFailure(reading, dimension, dimension, engineBox.hi[c] - engineBox.lo[c], fusionBox.hi[c] - fusionBox.lo[c]);
  });
}

/** 판재 두께: 부품 안의 판마다 재고, 가장 크게 어긋난 판 하나만 알린다. */
function thicknessFailures(reading: PartReading, panels: PanelPair[]): PartFailure[] {
  const worst = panels
    .filter((pair) => pair.part === reading.part)
    .map((pair) => ({ pair, engine: pair.gap(reading.engine), fusion: pair.gap(reading.fusion) }))
    .reduce<{ pair: PanelPair; engine: number; fusion: number } | undefined>(
      (w, x) => (w === undefined || Math.abs(x.engine - x.fusion) > Math.abs(w.engine - w.fusion) ? x : w),
      undefined,
    );
  if (!worst) return [];
  const label = `판 두께(${worst.pair.faces.join("·")})`;
  return dimensionFailure(reading, "thickness", label, worst.engine, worst.fusion, { faces: worst.pair.faces });
}

/** 녹화된 면 점을 엔진 형상의 면 순서대로 이어 붙인다. 면은 (바디, 이름)으로 짝짓고, 면 구성이 다르면 undefined다. */
function recordedPositions(shape: Topology, faces: SampleFace[]): Float64Array | undefined {
  if (faces.length !== shape.faces.length) return undefined;
  const byKey = new Map(faces.map((f) => [faceKey(f), f]));
  const out = new Float64Array(shape.faces.reduce((n, f) => n + f.count, 0) * 3);
  for (const face of shape.faces) {
    const recorded = byKey.get(faceKey(face));
    if (recorded?.points.length !== face.count) return undefined;
    recorded.points.forEach((p, j) => out.set(p, (face.start + j) * 3));
  }
  return out;
}

/** 면들의 꼭짓점을 감싸는 바운딩 박스 */
const bounds = (faces: MorphFace[], positions: Float64Array): Bounds =>
  boundsOf((visit) => {
    for (const face of faces) {
      for (let i = face.start; i < face.start + face.count; i++) visit(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    }
  });

/** 면들에서 같은 꼭짓점끼리 잰 거리의 최댓값 */
function maxDistance(faces: MorphFace[], a: Float64Array, b: Float64Array): number {
  let max = 0;
  for (const face of faces) {
    for (let i = face.start * 3; i < (face.start + face.count) * 3; i += 3) {
      max = Math.max(max, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]));
    }
  }
  return max;
}

interface PanelPair {
  part: string;
  /** 판의 두 면 이름 */
  faces: [string, string];
  /** 두 면 사이 간격(첫 면 법선 방향 평균 위치의 차) */
  gap(positions: Float64Array): number;
}

/**
 * 판재 두께를 재는 면 쌍. 같은 바디에서 법선이 서로 반대이고 서로 등지고 있으며(사이가 재료),
 * 위상 묶음 기준 형상에서 간격이 MAX_THICKNESS 이하인 두 평면이다. 연결과 마찬가지로 묶음의 기준 형상에서 한 번 정한다.
 */
function panelPairs(topology: Topology, geometry: Map<string, Geometry>): PanelPair[] {
  const planes = topology.faces.flatMap((face, i) => {
    const surface = geometry.get(faceKey(face));
    return surface?.type === "plane" ? [{ i, face, normal: surface.normal }] : [];
  });
  const base = topology.base;
  /** 면 점들을 법선 n에 내린 평균 위치 */
  const offset = (face: MorphFace, n: Vector, positions: Float64Array) => {
    let sum = 0;
    for (let i = face.start; i < face.start + face.count; i++) sum += dot(positions.subarray(i * 3, i * 3 + 3), n);
    return sum / face.count;
  };
  const pairs: PanelPair[] = [];
  for (const a of planes) {
    for (const b of planes) {
      if (b.i <= a.i || a.face.body !== b.face.body || dot(a.normal, b.normal) > -0.999) continue;
      // b가 a의 뒤(법선 반대쪽)에 있어야 둘 사이가 재료다
      const gap = (positions: Float64Array) => offset(a.face, a.normal, positions) - offset(b.face, a.normal, positions);
      const baseGap = gap(base);
      if (baseGap <= 0 || baseGap > MAX_THICKNESS) continue;
      pairs.push({ part: a.face.part, faces: [a.face.name, b.face.name], gap });
    }
  }
  return pairs;
}
