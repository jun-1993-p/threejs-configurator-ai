// 변형 엔진: 단독 스윕 샘플 사이의 꼭짓점 이동량을 슬라이더 값으로 섞는다(ADR-0002, 0004).
// 덧셈이 틀리는 슬라이더 쌍은 애드인이 뽑은 3×3 격자로 보강해 격자 보간을 더한다(ADR-0008).
// 슬라이더가 위상 경계를 넘으면 그 위상 묶음의 기준 형상과 단독 스윕으로 바꿔 섞는다. 경계에서는 페이드 없이 바로 바뀐다(ADR-0005).
// 두께 선택은 두께 후보 형상의 이동량을 사이 값 없이 바꿔 끼운 뒤 슬라이더 이동량에 더한다(ADR-0010).
// 두께 후보와 덧셈이 틀리는 슬라이더도 같은 방법으로 격자 보강한다(두께 후보마다 슬라이더 방향으로만 보간).
// 구성기(브라우저)와 검증기(Node)가 이 파일을 그대로 같이 쓴다. DOM이나 three.js에 기대지 않는다.

export type Vector = [number, number, number];
export type Triangle = [number, number, number];
/** W 폭·D 깊이·H 높이 */
export type Axis = "W" | "D" | "H";

/** 명세(JSON). 구조는 docs/spec-schema.md를 따른다. 엔진은 sliders의 id·default·범위와 thickness만 읽는다. */
export interface Spec {
  product: string;
  front: string;
  axes: Record<Axis, string>;
  sliders: Slider[];
  thickness: { ids: string[]; name: string; default: number; options: number[] }[];
  fixed: string[];
}

/** 두께 선택: ids의 파라미터를 함께 options 중 하나로 바꾼다(ADR-0010) */
export type ThicknessChoice = Spec["thickness"][number];

/** 표준 두께 목록(mm): 한국에서 유통되는 판재 두께. 명세 검사가 두께 후보를 이 목록으로 본다. */
export const STANDARD_THICKNESSES = [3, 6, 9, 12, 15, 18, 24, 30] as const;

/** 기본 두께의 두께 후보: 표준 두께 목록에서 앞뒤 한 칸과 기본 두께. 목록 끝이면 2개, 목록에 없으면 빈 목록이다. */
export function thicknessOptions(base: number): number[] {
  const i = STANDARD_THICKNESSES.findIndex((t) => t === base);
  return i === -1 ? [] : STANDARD_THICKNESSES.slice(Math.max(0, i - 1), i + 2);
}

export interface Slider {
  id: string;
  name: string;
  axis: Axis;
  min: number;
  max: number;
  default: number;
  step: number;
  unit: string;
  source: string;
  children: string[];
  affects: { shape: string[]; move: string[] };
}

export interface SampleFace {
  body: string;
  name: string;
  points: Vector[];
}

/** 여러 파라미터를 함께 바꾼 형상(업로드 묶음 스키마의 crossSample). 격자 보강 샘플도 이 형식이다. */
export interface CrossSample {
  values: Record<string, number>;
  status: "ok" | "recompute_failed";
  faces: SampleFace[];
}

/** 슬라이더 쌍: 두 부모 파라미터 이름, 명세 순서 */
export type Pair = [string, string];

/** 같은 슬라이더 쌍인지 */
export const samePair = (a: Pair, b: Pair) => a[0] === b[0] && a[1] === b[1];

/** 쌍이 명세의 어디인지: 두 슬라이더(번호 i·j), 또는 두께 쌍(두께 선택 번호 choice와 슬라이더 번호 j) */
export type PairRef = { kind: "sliders"; i: number; j: number } | { kind: "thickness"; choice: number; j: number };

/**
 * 쌍이 명세에서 가리키는 곳. 둘째는 슬라이더이고, 첫째는 슬라이더이거나 두께 선택의 첫 파라미터(두께 쌍)다.
 * 명세에 없는 쌍이면 undefined다. 격자 보강과 교차 검증이 같이 쓴다.
 */
export function findPair(spec: Spec, [a, b]: Pair): PairRef | undefined {
  const j = spec.sliders.findIndex((s) => s.id === b);
  if (j === -1) return undefined;
  const i = spec.sliders.findIndex((s) => s.id === a);
  if (i !== -1) return { kind: "sliders", i, j };
  const choice = spec.thickness.findIndex((c) => c.ids[0] === a);
  return choice === -1 ? undefined : { kind: "thickness", choice, j };
}

/** 두께 선택의 기본 두께가 아닌 두께 후보 */
export const nonDefaultOptions = (choice: ThicknessChoice) => choice.options.filter((o) => o !== choice.default);

/**
 * 격자 보강 쌍: 두 파라미터의 min·default·max를 엇걸어 뽑은 샘플(ADR-0008). 보통 3×3이고, default가 범위 끝이면
 * 그 축은 값 2개다. 명세가 아니라 애드인 결과에 담긴다.
 * 두께 쌍은 parameters가 [두께 선택의 파라미터, 슬라이더]이고, 기본 두께가 아닌 후보마다 슬라이더의 min·default·max다.
 */
export interface GridSweep {
  parameters: Pair;
  samples: CrossSample[];
}

type Part = { name: string; faces: number[] };
type Baseline = { faces: (SampleFace & { triangles: Triangle[] })[] };

/** 단독 스윕(업로드 묶음 스키마의 sweep). groups는 기본 묶음 밖의 위상 묶음이다. */
export interface Sweep {
  parameter: string;
  samples: { value: number; status: "ok" | "recompute_failed"; faces: SampleFace[] }[];
  groups?: TopologyGroup[];
}

/**
 * 위상 묶음(ADR-0005): 이 파라미터 값이 range 안이면 면 구성이 baseline과 같다. sweeps는 이 파라미터를 anchor에 두고
 * 뽑은 나머지 파라미터의 단독 스윕이다. 명세가 아니라 스윕 데이터에 담긴다.
 */
export interface TopologyGroup {
  range: { min: number; max: number };
  anchor: number;
  counts: Record<string, number>;
  parts: Part[];
  baseline: Baseline;
  sweeps: Omit<Sweep, "groups">[];
}

/**
 * 스윕 데이터. 업로드 묶음(schema/upload-bundle.schema.json)에서 엔진이 쓰는 부분과, 검증 중에 받은 격자 보강·두께 후보 형상이다.
 * thickness는 thicknessSamplePlan의 값 묶음마다 받은 형상이다.
 */
export interface SweepData {
  parts: Part[];
  baseline: Baseline;
  sweeps: Sweep[];
  grids?: GridSweep[];
  thickness?: CrossSample[];
}

export interface MorphFace {
  body: string;
  name: string;
  /** 이 면이 속한 부품 이름. 부품에 들지 않은 면은 바디 이름. */
  part: string;
  /** positions 안에서 이 면의 첫 꼭짓점 번호와 꼭짓점 수 */
  start: number;
  count: number;
}

/** 위상 묶음 하나의 면 구성. 같은 묶음이면 슬라이더 값이 달라도 같은 객체다. */
export interface Topology {
  faces: MorphFace[];
  /** 꼭짓점 번호 세 개씩. 묶음의 기준 형상에서 정한 연결이다. */
  triangles: Uint32Array;
  /** 묶음 기준 형상의 꼭짓점 위치 */
  base: Float64Array;
}

/** 슬라이더 값에 맞는 형상: 그 값이 든 위상 묶음의 면 구성과 꼭짓점 위치(x y z 순으로 이어 붙임) */
export interface MorphShape extends Topology {
  positions: Float64Array;
}

/** faces·triangles·base는 기본 묶음(기본 형상)의 것이다. */
export interface Morph extends Topology {
  /**
   * 슬라이더 값과 두께 선택 값에 맞는 형상. 두께 선택은 묶인 파라미터 중 아무 이름으로 주고, 두께 후보 중 하나여야 한다.
   * 빠진 값은 명세의 default다.
   */
  shape(values: Record<string, number>): MorphShape;
  /** shape(values).positions */
  positions(values: Record<string, number>): Float64Array;
}

interface Track {
  id: string;
  defaultValue: number;
  values: number[];
  /** values와 같은 순서의 샘플별 꼭짓점 이동량(위상 묶음 기준 형상 기준) */
  deltas: Float64Array[];
}

/** 두께 선택 하나. 기본 두께가 아닌 후보마다 이동량(위상 묶음 기준 형상 기준)을 둔다. */
interface ThicknessTrack {
  choice: ThicknessChoice;
  deltas: Map<number, Float64Array>;
}

/** 격자 보강 쌍. 덧셈 결과에 더할 나머지(격자 샘플 - 두 단독 스윕 이동량)를 격자 마디마다 둔다. */
interface GridTrack {
  ids: Pair;
  defaults: [number, number];
  /** 두 파라미터의 격자 값(오름차순) */
  values: [number[], number[]];
  /** residuals[i][j]: values[0][i]·values[1][j] 마디의 나머지 이동량 */
  residuals: Float64Array[][];
}

/** 샘플 사이에서 면을 짝짓는 키: (바디, 면 이름) */
export const faceKey = (f: { body: string; name: string }) => `${f.body}/${f.name}`;

/** 두께 쌍의 격자 보강. 기본 두께가 아닌 후보마다, 슬라이더 격자 값마다 나머지(격자 샘플 - 슬라이더 이동량 - 두께 후보 이동량)를 둔다. */
interface ThicknessGridTrack {
  choice: ThicknessChoice;
  /** 슬라이더 id와 default */
  id: string;
  defaultValue: number;
  /** 슬라이더 격자 값(오름차순) */
  values: number[];
  /** 두께 후보마다 values와 같은 순서의 나머지 이동량 */
  residuals: Map<number, Float64Array[]>;
}

/** 위상 묶음 하나의 엔진: 기준 형상과 슬라이더마다의 단독 스윕 이동량, 격자 보강 */
interface GroupMorph extends Topology {
  tracks: Track[];
  grids: GridTrack[];
  thickness: ThicknessTrack[];
  thicknessGrids: ThicknessGridTrack[];
}

/** 두 값 묶음이 같은 파라미터에 같은 값인지 */
const sameValues = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([id, v]) => b[id] === v);

/** 값 묶음을 오류·힌트에 쓰는 자리 표기로: "t=24·shelf_w=675" */
export const placeOf = (values: Record<string, number>) => Object.entries(values).map(([id, v]) => `${id}=${v}`).join("·");

/** 위상 묶음의 기준 값: 묶음을 가진 슬라이더와 그 anchor */
export interface GroupAnchor {
  slider: string;
  value: number;
}

/** 두께 선택이 그 후보일 때의 값 묶음. anchor가 있으면 그 위상 묶음의 기준 값을 더한다. */
export const thicknessValues = (choice: ThicknessChoice, option: number, anchor?: GroupAnchor) => ({
  ...Object.fromEntries(choice.ids.map((id) => [id, option])),
  ...(anchor ? { [anchor.slider]: anchor.value } : {}),
});

/** 두께 선택의 지금 값: 묶인 파라미터 중 values에 있는 첫 이름의 값, 없으면 기본 두께 */
export const thicknessValueOf = (choice: ThicknessChoice, values: Record<string, number>) =>
  choice.ids.map((id) => values[id]).find((v) => v !== undefined) ?? choice.default;

/** 두께 후보 형상 하나: 명세의 choice번째 두께 선택을 option으로 바꾸고, anchor 위상 묶음(없으면 기본 묶음)의 기준 형상에서 뽑는다 */
export interface ThicknessSample {
  choice: number;
  option: number;
  anchor?: GroupAnchor;
  /** 이 형상과 면 구성이 같아야 하는 기준 형상 */
  baseline: Baseline;
  /** 애드인에 요청할 값 묶음. 나머지 파라미터는 업로드한 모델의 값이다. */
  values: Record<string, number>;
}

/**
 * 받아야 할 두께 후보 형상: 기본 묶음과 슬라이더 범위가 닿는 위상 묶음마다, 두께 선택마다, 기본 두께가 아닌 후보마다 하나.
 * 엔진이 찾는 값 묶음과 애드인에 요청하는 값 묶음이 어긋나지 않도록 둘 다 이 목록을 쓴다.
 */
export function thicknessSamplePlan(spec: Spec, data: SweepData): ThicknessSample[] {
  const groups = [
    { baseline: data.baseline, anchor: undefined as GroupAnchor | undefined },
    ...spec.sliders.flatMap((slider) =>
      (data.sweeps.find((s) => s.parameter === slider.id)?.groups ?? [])
        .filter((g) => reaches(slider, g))
        .map((g) => ({ baseline: g.baseline, anchor: { slider: slider.id, value: g.anchor } })),
    ),
  ];
  return groups.flatMap(({ baseline, anchor }) =>
    spec.thickness.flatMap((choice, i) =>
      nonDefaultOptions(choice).map((option) => ({ choice: i, option, ...(anchor ? { anchor } : {}), baseline, values: thicknessValues(choice, option, anchor) })),
    ),
  );
}

/**
 * 위상 묶음 하나를 만든다. samplesOf는 슬라이더의 이 묶음 안 단독 스윕 샘플이고, name은 오류에 붙이는 묶음 이름이다.
 * 이동량은 이 묶음의 기준 형상(baseline)에서 잰다.
 */
function createGroupMorph(
  spec: Spec,
  parts: Part[],
  baseline: Baseline["faces"],
  samplesOf: (slider: Slider) => Sweep["samples"] | undefined,
  name: string,
  gridSweeps: GridSweep[],
  thickness: { samples: CrossSample[]; anchor?: GroupAnchor },
): GroupMorph {
  const partOf = new Map<number, string>();
  for (const part of parts) for (const i of part.faces) partOf.set(i, part.name);

  const faces: MorphFace[] = [];
  const base: number[] = [];
  const triangles: number[] = [];
  baseline.forEach((face, i) => {
    const start = base.length / 3;
    faces.push({ body: face.body, name: face.name, part: partOf.get(i) ?? face.body, start, count: face.points.length });
    for (const p of face.points) base.push(...p);
    for (const t of face.triangles) triangles.push(start + t[0], start + t[1], start + t[2]);
  });
  const basePositions = Float64Array.from(base);
  const faceIndex = new Map(baseline.map((f, i) => [faceKey(f), i]));

  /** 샘플 형상의 기준 형상 기준 이동량. 면 구성이 기준 형상과 다르면 undefined다. */
  const deltaOf = (sampleFaces: SampleFace[]): Float64Array | undefined => {
    const delta = new Float64Array(basePositions.length);
    if (sampleFaces.length !== baseline.length) return undefined;
    for (const face of sampleFaces) {
      const i = faceIndex.get(faceKey(face));
      if (i === undefined || face.points.length !== faces[i].count) return undefined;
      const offset = faces[i].start * 3;
      face.points.forEach((p, j) => {
        for (let c = 0; c < 3; c++) delta[offset + j * 3 + c] = p[c] - basePositions[offset + j * 3 + c];
      });
    }
    return delta;
  };

  const tracks: Track[] = spec.sliders.map((slider) => {
    const found = samplesOf(slider);
    if (!found) throw new Error(`슬라이더 ${slider.id}: ${name}에 이 파라미터의 단독 스윕이 없습니다`);
    const samples = found.filter((s) => s.status === "ok").sort((a, b) => a.value - b.value);
    if (samples.length < 2) throw new Error(`슬라이더 ${slider.id}: ${name}에서 재계산에 성공한 샘플이 2개보다 적습니다`);
    return {
      id: slider.id,
      defaultValue: slider.default,
      values: samples.map((s) => s.value),
      deltas: samples.map((s) => {
        const delta = deltaOf(s.faces);
        if (!delta) throw new Error(`슬라이더 ${slider.id}: 값 ${s.value}의 샘플이 ${name}의 기준 형상과 면 구성이 다릅니다`);
        return delta;
      }),
    };
  });

  // 두께 후보 형상은 이 묶음의 기준 형상에서 두께만 바꾼 형상이다. 이동량을 그대로 두고, 고르면 슬라이더 이동량에 더한다.
  const thicknessTracks: ThicknessTrack[] = spec.thickness.map((choice) => {
    const deltas = new Map<number, Float64Array>();
    for (const option of nonDefaultOptions(choice)) {
      const values = thicknessValues(choice, option, thickness.anchor);
      const place = placeOf(values);
      const sample = thickness.samples.find((s) => sameValues(s.values, values));
      if (!sample) throw new Error(`두께 선택 ${choice.ids[0]}: ${name}에 ${place} 형상이 없습니다`);
      if (sample.status !== "ok") throw new Error(`두께 선택 ${choice.ids[0]}: ${place}에서 재계산에 실패한 형상입니다`);
      const delta = deltaOf(sample.faces);
      if (!delta) throw new Error(`두께 선택 ${choice.ids[0]}: ${place}의 형상이 ${name}의 기준 형상과 면 구성이 다릅니다`);
      deltas.set(option, delta);
    }
    return { choice, deltas };
  });

  /**
   * 격자 마디 하나의 나머지 이동량: 샘플 이동량에서 덧셈이 이미 더하는 이동량(additive가 채운다)을 뺀다.
   * grid는 오류에 붙이는 격자 이름, place는 마디 자리다.
   */
  const residualOf = (grid: string, place: string, sample: CrossSample | undefined, additive: (out: Float64Array) => void) => {
    if (!sample) throw new Error(`${grid}: ${place} 샘플이 없습니다`);
    if (sample.status !== "ok") throw new Error(`${grid}: ${place}에서 재계산에 실패한 샘플입니다`);
    const residual = deltaOf(sample.faces);
    if (!residual) throw new Error(`${grid}: ${place}의 샘플이 기본 형상과 면 구성이 다릅니다`);
    const sum = new Float64Array(residual.length);
    additive(sum);
    for (let i = 0; i < residual.length; i++) residual[i] -= sum[i];
    return residual;
  };

  // 명세의 두 슬라이더를 잇는 격자만 쓴다. 격자 값이 슬라이더 범위와 맞는지는 엔진이 보지 않는다.
  // 범위나 기본값이 바뀐 명세에는 그 격자를 넣지 않는 것이 부르는 쪽(실행기)의 몫이다.
  const trackOf = new Map(tracks.map((t) => [t.id, t]));
  const grids: GridTrack[] = gridSweeps.flatMap(({ parameters, samples }) => {
    const pair = parameters.map((id) => trackOf.get(id));
    if (!pair[0] || !pair[1]) return [];
    const [a, b] = pair as [Track, Track];
    const name = `격자 보강 ${a.id}·${b.id}`;
    const values = parameters.map((id) => [...new Set(samples.map((s) => s.values[id]))].sort((x, y) => x - y)) as [number[], number[]];
    if (values[0].length < 2 || values[1].length < 2 || samples.length !== values[0].length * values[1].length) {
      throw new Error(`${name}: 샘플이 두 파라미터 값의 모든 조합을 하나씩 덮지 않습니다`);
    }
    const residuals = values[0].map((va) =>
      values[1].map((vb) => {
        const sample = samples.find((s) => s.values[a.id] === va && s.values[b.id] === vb);
        // 덧셈이 이미 더하는 두 단독 스윕 이동량을 뺀다. 두 파라미터가 서로 독립이면 기본값 줄의 나머지는 0이다.
        // 한쪽이 Fusion 수식으로 다른 쪽을 따르면(전체 깊이·서랍 깊이) 기본값 줄에서도 나머지가 남는다.
        // 슬라이더로 내놓은 값은 고정되므로, 이 쌍은 단독 스윕이 아니라 격자를 따른다.
        return residualOf(name, `${a.id}=${va}·${b.id}=${vb}`, sample, (sum) => {
          addDelta(sum, a, va);
          addDelta(sum, b, vb);
        });
      }),
    );
    return [{ ids: [a.id, b.id], defaults: [a.defaultValue, b.defaultValue], values, residuals }];
  });

  // 두께 쌍의 격자: 첫 파라미터가 두께 선택, 둘째가 명세의 슬라이더인 격자만 쓴다. 기본 두께에서는 더하지 않는다.
  const thicknessGrids: ThicknessGridTrack[] = gridSweeps.flatMap(({ parameters, samples }) => {
    const ref = findPair(spec, parameters);
    if (ref?.kind !== "thickness") return [];
    const thicknessTrack = thicknessTracks[ref.choice];
    const track = tracks[ref.j];
    const { choice } = thicknessTrack;
    const [first, id] = parameters;
    const name = `격자 보강 ${first}·${id}`;
    const options = nonDefaultOptions(choice);
    const values = [...new Set(samples.map((s) => s.values[id]))].sort((x, y) => x - y);
    if (values.length < 2 || samples.length !== options.length * values.length) {
      throw new Error(`${name}: 샘플이 기본 두께가 아닌 후보와 슬라이더 값의 모든 조합을 하나씩 덮지 않습니다`);
    }
    const residuals = new Map(
      options.map((option) => [
        option,
        values.map((v) => {
          const sample = samples.find((s) => thicknessValueOf(choice, s.values) === option && s.values[id] === v);
          // 덧셈이 이미 더하는 슬라이더 이동량과 두께 후보 이동량을 뺀다
          return residualOf(name, `${first}=${option}·${id}=${v}`, sample, (sum) => {
            addDelta(sum, track, v);
            addThickness(sum, thicknessTrack, option);
          });
        }),
      ]),
    );
    return [{ choice, id, defaultValue: track.defaultValue, values, residuals }];
  });

  return { faces, triangles: Uint32Array.from(triangles), base: basePositions, tracks, grids, thickness: thicknessTracks, thicknessGrids };
}

/** 위상 묶음이 있는 슬라이더에서 묶음 하나가 덮는 값: 그 묶음에 든 샘플 값의 최솟값·최댓값 */
interface GroupSpan {
  morph: GroupMorph;
  min: number;
  max: number;
}

/** 슬라이더 범위가 위상 묶음에 닿는지. 닿지 않는 묶음은 결과물에 담지 않고 검증하지 않는다. */
export const reaches = (slider: Slider, group: { range: { min: number; max: number } }) =>
  group.range.max >= slider.min && group.range.min <= slider.max;

/** 값이 위상 묶음의 값 구간(닫힌 구간)에 드는지. 조립이 닿지 않는 묶음의 샘플을 거를 때도 같은 경계를 쓴다. */
export const inGroup = (group: { range: { min: number; max: number } }, value: number) => group.range.min <= value && value <= group.range.max;

export function createMorph(spec: Spec, data: SweepData): Morph {
  const sweepOf = (id: string) => data.sweeps.find((s) => s.parameter === id);
  const groupsOf = (id: string) => sweepOf(id)?.groups ?? [];

  // 기본 묶음: 위상 묶음에 든 샘플은 뺀다. 격자 보강은 기본 묶음에서만 쓴다(격자 샘플은 기본 형상의 면 구성이다).
  const main = createGroupMorph(
    spec,
    data.parts,
    data.baseline.faces,
    (slider) => sweepOf(slider.id)?.samples.filter((s) => !groupsOf(slider.id).some((g) => inGroup(g, s.value))),
    "스윕 데이터",
    data.grids ?? [],
    { samples: data.thickness ?? [] },
  );

  // 위상 묶음이 있는 슬라이더마다 묶음별 범위. 그 슬라이더가 묶음 안이면 나머지 슬라이더는 묶음 안의 단독 스윕으로 섞는다.
  const grouped = spec.sliders.flatMap((slider) => {
    const groups = groupsOf(slider.id);
    if (groups.length === 0) return [];
    const own = main.tracks.find((t) => t.id === slider.id)!.values;
    const spans: GroupSpan[] = [{ morph: main, min: own[0], max: own[own.length - 1] }];
    for (const group of groups) {
      const morph = createGroupMorph(
        spec,
        group.parts,
        group.baseline.faces,
        (other) =>
          other.id === slider.id
            ? sweepOf(slider.id)!.samples.filter((s) => inGroup(group, s.value))
            : group.sweeps.find((s) => s.parameter === other.id)?.samples,
        `${slider.id} ${group.range.min}~${group.range.max} 위상 묶음`,
        [],
        { samples: data.thickness ?? [], anchor: { slider: slider.id, value: group.anchor } },
      );
      spans.push({ morph, min: group.range.min, max: group.range.max });
    }
    return [{ id: slider.id, defaultValue: slider.default, spans }];
  });

  /**
   * 값이 든 위상 묶음. 묶음 사이 틈(경계 양쪽 샘플 사이)에서는 가까운 쪽이므로 틈 가운데가 경계다.
   * 여러 슬라이더가 저마다 기본 묶음 밖이면 명세 순서로 앞 슬라이더의 묶음을 따르고, 뒤 슬라이더는 그 묶음 안 단독 스윕의
   * 범위 끝에 붙는다. 묶음 안 단독 스윕은 위상이 바뀌는 앞에서 범위가 줄어 있고, 그 너머의 명세는 범위 검증이 거른다.
   */
  const groupFor = (values: Record<string, number>): GroupMorph => {
    for (const { id, defaultValue, spans } of grouped) {
      const value = values[id] ?? defaultValue;
      const gap = (span: GroupSpan) => Math.max(span.min - value, value - span.max, 0);
      const nearest = spans.reduce((best, span) => (gap(span) < gap(best) ? span : best));
      if (nearest.morph !== main) return nearest.morph;
    }
    return main;
  };

  const shape = (values: Record<string, number>): MorphShape => {
    const morph = groupFor(values);
    const out = Float64Array.from(morph.base);
    for (const track of morph.tracks) addDelta(out, track, values[track.id] ?? track.defaultValue);
    for (const grid of morph.grids) addResidual(out, grid, grid.ids.map((id, k) => values[id] ?? grid.defaults[k]) as [number, number]);
    for (const track of morph.thickness) addThickness(out, track, thicknessValueOf(track.choice, values));
    for (const grid of morph.thicknessGrids) addThicknessResidual(out, grid, thicknessValueOf(grid.choice, values), values[grid.id] ?? grid.defaultValue);
    return { faces: morph.faces, triangles: morph.triangles, base: morph.base, positions: out };
  };

  return { faces: main.faces, triangles: main.triangles, base: main.base, shape, positions: (values) => shape(values).positions };
}

/** 값을 감싸는 두 샘플 번호와 그 사이 비율. 샘플 범위 밖의 값은 끝 샘플에 붙인다. */
function bracket(values: number[], value: number): { lo: number; hi: number; t: number } {
  let hi = values.findIndex((v) => v >= value);
  if (hi === -1) hi = values.length - 1;
  if (hi === 0) hi = 1;
  const lo = hi - 1;
  return { lo, hi, t: Math.min(1, Math.max(0, (value - values[lo]) / (values[hi] - values[lo]))) };
}

/** 값을 감싸는 두 샘플의 이동량을 선형으로 섞어 더한다. */
function addDelta(out: Float64Array, track: Track, value: number) {
  const { lo, hi, t } = bracket(track.values, value);
  const a = track.deltas[lo];
  const b = track.deltas[hi];
  for (let i = 0; i < out.length; i++) out[i] += a[i] + (b[i] - a[i]) * t;
}

/** 고른 두께 후보의 이동량을 더한다. 기본 두께면 더할 것이 없고, 후보가 아닌 값은 보간하지 않고 오류다. */
function addThickness(out: Float64Array, { choice, deltas }: ThicknessTrack, value: number) {
  if (value === choice.default) return;
  const delta = deltas.get(value);
  if (!delta) throw new Error(`두께 선택 ${choice.ids[0]}: ${value} mm는 후보(${choice.options.join("·")})가 아닙니다`);
  for (let i = 0; i < out.length; i++) out[i] += delta[i];
}

/** 고른 두께 후보의 나머지 이동량을 슬라이더 값으로 선형 보간해 더한다. 기본 두께면 더할 것이 없다. */
function addThicknessResidual(out: Float64Array, grid: ThicknessGridTrack, option: number, value: number) {
  const residuals = grid.residuals.get(option);
  if (!residuals) return;
  const { lo, hi, t } = bracket(grid.values, value);
  const [a, b] = [residuals[lo], residuals[hi]];
  for (let i = 0; i < out.length; i++) out[i] += a[i] + (b[i] - a[i]) * t;
}

/** 두 값을 감싸는 격자 칸 네 마디의 나머지 이동량을 쌍선형으로 섞어 더한다. */
function addResidual(out: Float64Array, grid: GridTrack, [va, vb]: [number, number]) {
  const u = bracket(grid.values[0], va);
  const v = bracket(grid.values[1], vb);
  const r = grid.residuals;
  const [r00, r01, r10, r11] = [r[u.lo][v.lo], r[u.lo][v.hi], r[u.hi][v.lo], r[u.hi][v.hi]];
  const [w00, w01, w10, w11] = [(1 - u.t) * (1 - v.t), (1 - u.t) * v.t, u.t * (1 - v.t), u.t * v.t];
  for (let i = 0; i < out.length; i++) out[i] += r00[i] * w00 + r01[i] * w01 + r10[i] * w10 + r11[i] * w11;
}
