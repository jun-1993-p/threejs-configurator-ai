// 변형 엔진: 단독 스윕 샘플 사이의 꼭짓점 이동량을 슬라이더 값으로 섞는다(ADR-0002, 0004).
// 덧셈이 틀리는 슬라이더 쌍은 애드인이 뽑은 3×3 격자로 보강해 격자 보간을 더한다(ADR-0008).
// 구성기(브라우저)와 검증기(Node)가 이 파일을 그대로 같이 쓴다. DOM이나 three.js에 기대지 않는다.

export type Vector = [number, number, number];
export type Triangle = [number, number, number];
/** W 폭·D 깊이·H 높이 */
export type Axis = "W" | "D" | "H";

/** 명세(JSON). 구조는 docs/spec-schema.md를 따른다. 엔진은 sliders의 id와 default만 읽는다. */
export interface Spec {
  product: string;
  front: string;
  axes: Record<Axis, string>;
  sliders: Slider[];
  thickness: { ids: string[]; name: string; default: number; options: number[] }[];
  fixed: string[];
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

/**
 * 격자 보강 쌍: 두 파라미터의 min·default·max를 엇걸어 뽑은 샘플(ADR-0008). 보통 3×3이고, default가 범위 끝이면
 * 그 축은 값 2개다. 명세가 아니라 애드인 결과에 담긴다.
 */
export interface GridSweep {
  parameters: Pair;
  samples: CrossSample[];
}

/** 스윕 데이터. 업로드 묶음(schema/upload-bundle.schema.json)에서 엔진이 쓰는 부분과, 검증 중에 받은 격자 보강이다. */
export interface SweepData {
  parts: { name: string; faces: number[] }[];
  baseline: { faces: (SampleFace & { triangles: Triangle[] })[] };
  sweeps: {
    parameter: string;
    samples: { value: number; status: "ok" | "recompute_failed"; faces: SampleFace[] }[];
  }[];
  grids?: GridSweep[];
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

export interface Morph {
  faces: MorphFace[];
  /** 꼭짓점 번호 세 개씩. 기본 형상에서 정한 연결이며 슬라이더 값과 무관하다. */
  triangles: Uint32Array;
  /** 슬라이더 값(빠진 슬라이더는 명세의 default)에 맞는 꼭짓점 위치, x y z 순으로 이어 붙임 */
  positions(values: Record<string, number>): Float64Array;
}

interface Track {
  id: string;
  defaultValue: number;
  values: number[];
  /** values와 같은 순서의 샘플별 꼭짓점 이동량(기본 형상 기준) */
  deltas: Float64Array[];
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

export function createMorph(spec: Spec, data: SweepData): Morph {
  const baseline = data.baseline.faces;
  const partOf = new Map<number, string>();
  for (const part of data.parts) for (const i of part.faces) partOf.set(i, part.name);

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

  /** 샘플 형상의 기본 형상 기준 이동량. 면 구성이 기본 형상과 다르면 undefined다. */
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
    const sweep = data.sweeps.find((s) => s.parameter === slider.id);
    if (!sweep) throw new Error(`슬라이더 ${slider.id}: 스윕 데이터에 이 파라미터의 단독 스윕이 없습니다`);
    const samples = sweep.samples.filter((s) => s.status === "ok").sort((a, b) => a.value - b.value);
    if (samples.length < 2) throw new Error(`슬라이더 ${slider.id}: 재계산에 성공한 샘플이 2개보다 적습니다`);
    return {
      id: slider.id,
      defaultValue: slider.default,
      values: samples.map((s) => s.value),
      deltas: samples.map((s) => {
        const delta = deltaOf(s.faces);
        if (!delta) throw topologyChanged(slider.id, s.value);
        return delta;
      }),
    };
  });

  // 명세의 두 슬라이더를 잇는 격자만 쓴다. 격자 값이 슬라이더 범위와 맞는지는 엔진이 보지 않는다.
  // 범위나 기본값이 바뀐 명세에는 그 격자를 넣지 않는 것이 부르는 쪽(실행기)의 몫이다.
  const trackOf = new Map(tracks.map((t) => [t.id, t]));
  const grids: GridTrack[] = (data.grids ?? []).flatMap(({ parameters, samples }) => {
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
        if (!sample) throw new Error(`${name}: ${a.id}=${va}·${b.id}=${vb} 샘플이 없습니다`);
        if (sample.status !== "ok") throw new Error(`${name}: ${a.id}=${va}·${b.id}=${vb}에서 재계산에 실패한 샘플입니다`);
        const residual = deltaOf(sample.faces);
        if (!residual) throw new Error(`${name}: ${a.id}=${va}·${b.id}=${vb}의 샘플이 기본 형상과 면 구성이 다릅니다`);
        // 덧셈이 이미 더하는 두 단독 스윕 이동량을 뺀다. 두 파라미터가 서로 독립이면 기본값 줄의 나머지는 0이다.
        // 한쪽이 Fusion 수식으로 다른 쪽을 따르면(전체 깊이·서랍 깊이) 기본값 줄에서도 나머지가 남는다.
        // 슬라이더로 내놓은 값은 고정되므로, 이 쌍은 단독 스윕이 아니라 격자를 따른다.
        const additive = new Float64Array(residual.length);
        addDelta(additive, a, va);
        addDelta(additive, b, vb);
        for (let i = 0; i < residual.length; i++) residual[i] -= additive[i];
        return residual;
      }),
    );
    return [{ ids: [a.id, b.id], defaults: [a.defaultValue, b.defaultValue], values, residuals }];
  });

  return {
    faces,
    triangles: Uint32Array.from(triangles),
    positions(values) {
      const out = Float64Array.from(basePositions);
      for (const track of tracks) addDelta(out, track, values[track.id] ?? track.defaultValue);
      for (const grid of grids) addResidual(out, grid, grid.ids.map((id, k) => values[id] ?? grid.defaults[k]) as [number, number]);
      return out;
    },
  };
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

/** 두 값을 감싸는 격자 칸 네 마디의 나머지 이동량을 쌍선형으로 섞어 더한다. */
function addResidual(out: Float64Array, grid: GridTrack, [va, vb]: [number, number]) {
  const u = bracket(grid.values[0], va);
  const v = bracket(grid.values[1], vb);
  const r = grid.residuals;
  const [r00, r01, r10, r11] = [r[u.lo][v.lo], r[u.lo][v.hi], r[u.hi][v.lo], r[u.hi][v.hi]];
  const [w00, w01, w10, w11] = [(1 - u.t) * (1 - v.t), (1 - u.t) * v.t, u.t * (1 - v.t), u.t * v.t];
  for (let i = 0; i < out.length; i++) out[i] += r00[i] * w00 + r01[i] * w01 + r10[i] * w10 + r11[i] * w11;
}

function topologyChanged(id: string, value: number) {
  // 위상 묶음(ADR-0005)은 티켓 10·11에서 다룬다. 그 전까지는 면 구성이 다른 샘플을 받지 않는다.
  return new Error(`슬라이더 ${id}: 값 ${value}의 샘플이 기본 형상과 면 구성이 다릅니다(위상 묶음은 아직 지원하지 않음)`);
}
