// 변형 엔진: 단독 스윕 샘플 사이의 꼭짓점 이동량을 슬라이더 값으로 섞는다(ADR-0002, 0004).
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

/** 스윕 데이터. 업로드 묶음(schema/upload-bundle.schema.json)에서 엔진이 쓰는 부분이다. */
export interface SweepData {
  parts: { name: string; faces: number[] }[];
  baseline: { faces: (SampleFace & { triangles: Triangle[] })[] };
  sweeps: {
    parameter: string;
    samples: { value: number; status: "ok" | "recompute_failed"; faces: SampleFace[] }[];
  }[];
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

const key = (f: { body: string; name: string }) => `${f.body}/${f.name}`;

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
  const faceIndex = new Map(baseline.map((f, i) => [key(f), i]));

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
        const delta = new Float64Array(basePositions.length);
        if (s.faces.length !== baseline.length) throw topologyChanged(slider.id, s.value);
        for (const face of s.faces) {
          const i = faceIndex.get(key(face));
          if (i === undefined || face.points.length !== faces[i].count) throw topologyChanged(slider.id, s.value);
          const offset = faces[i].start * 3;
          face.points.forEach((p, j) => {
            for (let c = 0; c < 3; c++) delta[offset + j * 3 + c] = p[c] - basePositions[offset + j * 3 + c];
          });
        }
        return delta;
      }),
    };
  });

  return {
    faces,
    triangles: Uint32Array.from(triangles),
    positions(values) {
      const out = Float64Array.from(basePositions);
      for (const track of tracks) addDelta(out, track, values[track.id] ?? track.defaultValue);
      return out;
    },
  };
}

/** 값을 감싸는 두 샘플의 이동량을 선형으로 섞어 더한다. 샘플 범위 밖의 값은 끝 샘플에 붙인다. */
function addDelta(out: Float64Array, track: Track, value: number) {
  const { values, deltas } = track;
  let hi = values.findIndex((v) => v >= value);
  if (hi === -1) hi = values.length - 1;
  if (hi === 0) hi = 1;
  const lo = hi - 1;
  const t = Math.min(1, Math.max(0, (value - values[lo]) / (values[hi] - values[lo])));
  const a = deltas[lo];
  const b = deltas[hi];
  for (let i = 0; i < out.length; i++) out[i] += a[i] + (b[i] - a[i]) * t;
}

function topologyChanged(id: string, value: number) {
  // 위상 묶음(ADR-0005)은 티켓 10·11에서 다룬다. 그 전까지는 면 구성이 다른 샘플을 받지 않는다.
  return new Error(`슬라이더 ${id}: 값 ${value}의 샘플이 기본 형상과 면 구성이 다릅니다(위상 묶음은 아직 지원하지 않음)`);
}
