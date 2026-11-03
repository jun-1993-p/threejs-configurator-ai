// 파라미터 사이의 부모/자식 관계와 단독 스윕의 반응. 관계는 업로드 묶음의 Fusion 수식에서 읽기만 하고 풀지 않는다(ADR-0003).
// 후보 카드는 자식 치수를 바꿀 부모 후보와 같이 변하는 치수를, 명세 검사는 children을, AI 지시는 이름 짓기를 여기서 가져온다.
import type { SampleFace } from "../src/engine.ts";
import { boundsOf, round } from "./measure.ts";
import { FUSION_AXES, type FusionAxis } from "./schemas.ts";
import type { UploadBundle } from "./upload-bundle.ts";
import { DIMENSION_TOLERANCE } from "./verify-numeric.ts";

/** 문장 속 낱말(파라미터 이름 후보). 한글 파라미터 이름도 받는다. */
const WORD = /[\p{L}_][\p{L}\p{N}_]*/gu;

/** 수식이나 슬라이더 이름에 든 낱말 */
export const wordsOf = (text: string) => [...new Set(text.match(WORD) ?? [])];

/** 적응형 스윕의 샘플 상한(ADR-0007, 0012). 애드인의 SAMPLE_LIMIT와 같다. */
export const SAMPLE_LIMIT = 17;

type SweepFit = { parameter: string; samples: { status: string }[]; interpolation_failure?: unknown };

/** 업로드 묶음에서 파라미터 관계를 읽는 데 쓰는 부분 */
export type BundleParameters = {
  parameters: { name: string; expression: string; is_count: boolean }[];
  sweeps: (SweepFit & { groups?: { sweeps: SweepFit[] }[] })[];
};

/**
 * 스윕했어도 섞을 수 없는 파라미터와 그 까닭(슬라이더 후보가 될 수 없다는 문장). 보간 실패(ADR-0007)했거나, 재계산 실패로
 * 범위가 줄어 재계산에 성공한 샘플이 2개보다 적은 단독 스윕이다. 위상 묶음 안의 단독 스윕에서 그래도 그 파라미터는 섞을 수 없다.
 * 후보 검사와 명세 검사가 이 문장을 같이 쓴다.
 */
export function unmixableSweeps(bundle: BundleParameters): Map<string, string> {
  const all = bundle.sweeps.flatMap((s) => [s, ...(s.groups ?? []).flatMap((g) => g.sweeps)]);
  const out = new Map<string, string>();
  for (const s of all) {
    if (out.has(s.parameter)) continue;
    if (s.interpolation_failure !== undefined) {
      out.set(s.parameter, `${s.parameter}는 적응형 스윕을 ${SAMPLE_LIMIT}점까지 늘려도 보간 오차가 합격선을 넘어(보간 실패) 슬라이더 후보가 될 수 없습니다`);
    } else if (s.samples.filter((x) => x.status === "ok").length < 2) {
      out.set(s.parameter, `${s.parameter}는 재계산에 성공한 스윕 샘플이 2개보다 적어 보간할 수 없으므로 슬라이더 후보가 될 수 없습니다`);
    }
  }
  return out;
}

/**
 * 수식으로 이어진 관계. 슬라이더가 될 수 있는 파라미터는 스윕했고 개수형이 아니며 섞을 수 있는 것이다(ADR-0005, 0007).
 * - parentOptions(name): 슬라이더가 될 수 있으면 [name], 아니면 수식을 거슬러 닿는 슬라이더가 될 수 있는 파라미터(가까운 것부터)
 * - descendants(name): 수식이 name을 직접 또는 간접으로 따르는 파라미터(업로드 묶음 순서)
 */
export function parameterRelations(bundle: BundleParameters) {
  const names = new Set(bundle.parameters.map((p) => p.name));
  const uses = new Map(bundle.parameters.map((p) => [p.name, wordsOf(p.expression).filter((w) => names.has(w) && w !== p.name)]));
  const counts = new Set(bundle.parameters.filter((p) => p.is_count).map((p) => p.name));
  const swept = new Set(bundle.sweeps.map((s) => s.parameter));
  const unmixable = unmixableSweeps(bundle);
  const sliderable = (name: string) => swept.has(name) && !counts.has(name) && !unmixable.has(name);

  /** start에서 next를 따라 닿는 이름(start 제외), 가까운 것부터 */
  const reach = (start: string, step: (name: string) => string[]) => {
    const seen = new Set([start]);
    const order: string[] = [];
    for (let queue = [start]; queue.length > 0; ) {
      const next = [...new Set(queue.flatMap(step))].filter((n) => !seen.has(n));
      for (const n of next) seen.add(n);
      order.push(...next);
      queue = next;
    }
    return order;
  };
  const usedBy = (name: string) => bundle.parameters.filter((p) => uses.get(p.name)!.includes(name)).map((p) => p.name);

  return {
    sliderable,
    parentOptions: (name: string) => (sliderable(name) ? [name] : reach(name, (n) => uses.get(n) ?? []).filter(sliderable)),
    descendants: (name: string) => {
      const found = new Set(reach(name, usedBy));
      return bundle.parameters.map((p) => p.name).filter((n) => found.has(n));
    },
  };
}

type PerAxis = Record<FusionAxis, number>;

/** 단독 스윕에서 부품 하나가 기본 형상 대비 가장 크게 바뀐 양(Fusion 축별, mm). 0.2 mm 이하는 0으로 둔다. */
export interface PartResponse {
  part: string;
  size: PerAxis;
  move: PerAxis;
}

/** 파라미터 하나의 단독 스윕 반응: 상품 전체 바운딩 박스 치수와 부품마다의 변화. 이름이 의미 없는 파라미터의 이름을 짓는 근거다. */
export interface SweepResponse {
  overall: PerAxis;
  parts: PartResponse[];
}

const perAxis = (f: (c: number) => number) => Object.fromEntries(FUSION_AXES.map((a, c) => [a, f(c)])) as PerAxis;

function extent(faces: SampleFace[]) {
  const { lo, hi } = boundsOf((visit) => {
    for (const face of faces) for (const p of face.points) visit(p[0], p[1], p[2]);
  });
  return lo[0] === Infinity ? undefined : { size: perAxis((c) => hi[c] - lo[c]), center: perAxis((c) => (hi[c] + lo[c]) / 2) };
}

/**
 * 단독 스윕 전체(재계산에 성공한 샘플)에서 잰 반응. 축 반응 검증처럼 부품은 그 Fusion 바디의 모든 면으로 재고,
 * 치수 오차 합격선(0.2 mm) 안의 변화는 고객에게 같은 치수라 0으로 둔다. 스윕이 없으면 undefined다.
 */
export function sweepResponse(bundle: UploadBundle, parameter: string): SweepResponse | undefined {
  const sweep = bundle.sweeps.find((s) => s.parameter === parameter);
  if (!sweep) return undefined;
  const shapes = sweep.samples.filter((s) => s.status === "ok").map((s) => s.faces);
  const partBodies = bundle.parts.map((p) => ({ part: p.name, bodies: new Set(p.faces.map((i) => bundle.baseline.faces[i].body)) }));
  /** 기본 형상 대비 축마다 가장 크게 바뀐 양 */
  const largest = (pick: (faces: SampleFace[]) => SampleFace[], amount: "size" | "center") => {
    const base = extent(pick(bundle.baseline.faces));
    const changes = shapes.map((faces) => extent(pick(faces)));
    return perAxis((c) => {
      const a = FUSION_AXES[c];
      const worst = Math.max(0, ...changes.map((e) => (e && base ? Math.abs(e[amount][a] - base[amount][a]) : 0)));
      return worst > DIMENSION_TOLERANCE ? round(worst) : 0;
    });
  };
  return {
    overall: largest((faces) => faces, "size"),
    parts: partBodies.map(({ part, bodies }) => {
      const pick = (faces: SampleFace[]) => faces.filter((f) => bodies.has(f.body));
      return { part, size: largest(pick, "size"), move: largest(pick, "center") };
    }),
  };
}
