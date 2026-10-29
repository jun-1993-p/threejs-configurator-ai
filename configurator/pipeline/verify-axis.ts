// 축 반응 검증: 단독 스윕의 Fusion 형상에서 슬라이더마다 부품이 어느 축으로 어떻게 바뀌는지 재,
// 명세의 형태 변경 부품(affects.shape)·위치 이동 부품(affects.move)과 비교한다. 수치 검증을 통과한 뒤에 돈다.
// 규칙 표는 docs/spec-schema.md의 "축 반응" 표와 같다.
import type { Axis, SampleFace, Slider, Spec } from "../src/engine.ts";
import type { Feedback, FeedbackKind } from "./feedback.ts";
import { boundsOf, coordinateOf, DIMENSIONS, round } from "./measure.ts";
import type { UploadBundle } from "./upload-bundle.ts";
import { DIMENSION_TOLERANCE } from "./verify-numeric.ts";

/**
 * 기본 형상 대비 이 값(mm)을 넘게 달라져야 "바뀌었다"고 본다. 녹화 형상끼리 비교하므로 부동소수 차이만 걸러내면 되고,
 * 치수 오차 합격선(ADR-0012)과 같은 값을 쓴다. 합격선 안의 차이는 고객에게 같은 치수로 보이기 때문이다.
 */
const CHANGE_THRESHOLD = DIMENSION_TOLERANCE;

/** 부품의 W·D·H별 치수와 가운데 위치, mm */
type Extent = Record<Axis, { size: number; center: number }>;

/** 샘플 하나에서 기본 형상 대비 부품이 바뀐 양, W·D·H별 */
interface Change {
  /** 샘플(또는 검증점)의 슬라이더 값 */
  value: number;
  size: Record<Axis, number>;
  move: Record<Axis, number>;
}

/** 슬라이더 하나에 대한 부품의 선언: 형태 변경, 위치 이동, 선언 안 함 */
type Role = "shape" | "move" | "none";

/** 슬라이더 축 규칙 하나. 부품의 역할마다 앞에서부터 보고, 처음 걸린 규칙 하나만 알린다. */
interface AxisRule {
  role: Role;
  /** 재는 양: 치수(size) 또는 가운데 위치(move) */
  amount: "size" | "move";
  /** changed: 바뀌면 실패, unchanged: 범위 안 어느 샘플에서도 바뀌지 않으면 실패 */
  failsWhen: "changed" | "unchanged";
  kind: FeedbackKind;
  field: "affects.shape" | "affects.move";
  expected: (axis: Axis) => string;
  /** 힌트에서 부품을 어떻게 고치라는지 */
  fix: string;
}

const AXIS_RULES: AxisRule[] = [
  {
    role: "shape", amount: "size", failsWhen: "unchanged", kind: "missing_axis_change", field: "affects.shape",
    expected: (axis) => `${axis} 치수 변화`, fix: "affects.shape에서 빼거나",
  },
  {
    role: "move", amount: "size", failsWhen: "changed", kind: "unexpected_shape_change", field: "affects.move",
    expected: () => "위치 이동만", fix: "affects.move에서 affects.shape로 옮기거나",
  },
  {
    role: "move", amount: "move", failsWhen: "unchanged", kind: "missing_axis_change", field: "affects.move",
    expected: (axis) => `${axis} 방향 위치 이동`, fix: "affects.move에서 빼거나",
  },
  {
    role: "none", amount: "size", failsWhen: "changed", kind: "unexpected_shape_change", field: "affects.shape",
    expected: () => "변화 없음", fix: "affects.shape에 넣거나",
  },
  {
    role: "none", amount: "move", failsWhen: "changed", kind: "unexpected_move", field: "affects.move",
    expected: () => "변화 없음", fix: "affects.move에 넣거나",
  },
];

const AMOUNT_LABEL = { size: "치수", move: "위치" } as const;

/** 슬라이더 하나와 부품 하나의 축 반응 */
interface PartResponse {
  slider: Slider;
  index: number;
  part: string;
  /** 범위 안 샘플별 변화 */
  changes: Change[];
}

/**
 * 단독 스윕에서 잰 축 반응이 명세와 다른 항목을 검증 피드백으로 돌려준다. 통과하면 빈 목록이다.
 * 슬라이더 범위 안의 샘플과 검증점(재계산 성공, 기본값 제외)을 모두 보고, 부품·실패 종류마다 가장 크게 바뀐 샘플 하나를 알린다.
 * 명세의 부품 이름·스윕 유무는 명세 검사(schemas.ts의 specReferenceChecker)가 먼저 본다.
 */
export function verifyAxisResponse(spec: Spec, bundle: UploadBundle): Feedback[] {
  // 부품은 바디 단위로 잰다(ADR-0006). 샘플의 면 구성이 기본 형상과 달라도 바디의 모든 면으로 잰다.
  const partBodies = new Map(bundle.parts.map((p) => [p.name, new Set(p.faces.map((i) => bundle.baseline.faces[i].body))]));
  const extentsOf = (faces: SampleFace[]) => {
    const extents = new Map<string, Extent>();
    for (const [part, bodies] of partBodies) {
      const extent = measure(spec.axes, faces.filter((f) => bodies.has(f.body)));
      if (extent) extents.set(part, extent);
    }
    return extents;
  };
  const base = extentsOf(bundle.baseline.faces);

  return spec.sliders.flatMap((slider, index) => {
    const sweep = bundle.sweeps.find((s) => s.parameter === slider.id);
    const shapes = [...(sweep?.samples ?? []), ...(sweep?.checks ?? [])].filter(
      (s) => s.status === "ok" && s.value >= slider.min && s.value <= slider.max && s.value !== slider.default,
    );
    const changes = new Map<string, Change[]>();
    for (const shape of shapes) {
      for (const [part, extent] of extentsOf(shape.faces)) {
        const from = base.get(part);
        if (!from) continue;
        const change = {
          value: shape.value,
          size: perAxis((a) => extent[a].size - from[a].size),
          move: perAxis((a) => extent[a].center - from[a].center),
        };
        changes.set(part, [...(changes.get(part) ?? []), change]);
      }
    }
    return [...changes].flatMap(([part, partChanges]) => {
      const response = { slider, index, part, changes: partChanges };
      return [onAxisFeedback(response), offAxisFeedback(response)].filter((f) => f !== undefined);
    });
  });
}

/** 슬라이더 축의 반응을 부품의 역할에 맞는 규칙으로 판정한다. */
function onAxisFeedback({ slider, index, part, changes }: PartResponse): Feedback | undefined {
  const axis = slider.axis;
  const role: Role = slider.affects.shape.includes(part) ? "shape" : slider.affects.move.includes(part) ? "move" : "none";
  for (const rule of AXIS_RULES.filter((r) => r.role === role)) {
    const sample = largest(changes, (c) => c[rule.amount][axis]);
    if (!sample) continue;
    const amount = sample[rule.amount][axis];
    const changed = Math.abs(amount) > CHANGE_THRESHOLD;
    if (changed !== (rule.failsWhen === "changed")) continue;
    const label = `${part}의 ${axis} ${AMOUNT_LABEL[rule.amount]}`;
    const what = changed
      ? `${label}가 ${slider.id}=${sample.value}에서 ${round(amount)} mm 바뀝니다`
      : `${label}가 범위 안에서 바뀌지 않습니다(가장 큰 변화 ${slider.id}=${sample.value}에서 ${round(amount)} mm)`;
    return {
      path: `sliders[${index}].${rule.field}`,
      slider: slider.id,
      part,
      kind: rule.kind,
      measured: measured(sample, axis),
      expected: rule.expected(axis),
      hint: `${what}. ${part}를 sliders[${index}].${rule.fix}, ${CHECK_FORMULAS}`,
    };
  }
  return undefined;
}

/** 다른 축은 치수도 위치도 그대로여야 한다. 가장 크게 바뀐 축과 샘플 하나를 알린다. */
function offAxisFeedback({ slider, index, part, changes }: PartResponse): Feedback | undefined {
  let worst: { sample: Change; axis: Axis; amount: number } | undefined;
  for (const sample of changes) {
    for (const axis of DIMENSIONS.filter((a) => a !== slider.axis)) {
      const amount = Math.max(Math.abs(sample.size[axis]), Math.abs(sample.move[axis]));
      if (amount > (worst?.amount ?? CHANGE_THRESHOLD)) worst = { sample, axis, amount };
    }
  }
  if (!worst) return undefined;
  const { sample, axis } = worst;
  return {
    path: `sliders[${index}].axis`,
    slider: slider.id,
    part,
    kind: "off_axis_change",
    measured: measured(sample, axis),
    expected: `${slider.axis} 밖의 축은 그대로`,
    hint: `${part}의 ${axis}가 ${slider.id}=${sample.value}에서 바뀝니다(치수 ${round(sample.size[axis])} mm, 위치 ${round(sample.move[axis])} mm). sliders[${index}].axis가 맞는지, ${CHECK_FORMULAS}`,
  };
}

const CHECK_FORMULAS = "자식 수식을 확인하세요";

const measured = (sample: Change, axis: Axis) => ({
  value: sample.value,
  axis,
  size_delta_mm: round(sample.size[axis]),
  move_mm: round(sample.move[axis]),
});

/** 변화량 절댓값이 가장 큰 샘플. 같으면 앞의 것이다. */
const largest = (changes: Change[], amount: (c: Change) => number) =>
  changes.reduce<Change | undefined>((w, c) => (w === undefined || Math.abs(amount(c)) > Math.abs(amount(w)) ? c : w), undefined);

const perAxis = <T>(f: (a: Axis) => T) => Object.fromEntries(DIMENSIONS.map((a) => [a, f(a)])) as Record<Axis, T>;

/** 면 점들의 W·D·H별 치수와 가운데 위치. 점이 없으면 undefined다. */
function measure(axes: Spec["axes"], faces: SampleFace[]): Extent | undefined {
  const { lo, hi } = boundsOf((visit) => {
    for (const face of faces) for (const p of face.points) visit(p[0], p[1], p[2]);
  });
  if (lo[0] === Infinity) return undefined;
  return perAxis((a) => {
    const c = coordinateOf(axes, a);
    return { size: hi[c] - lo[c], center: (hi[c] + lo[c]) / 2 };
  });
}
