// 줄어든 스윕 범위: 애드인이 범위 끝 쪽의 위상 변화로 줄인 범위를 운영자와 AI에게 알린다(ADR-0005).
// 개수형 값이 함께 바뀐 위상 변화는 range_shrunk, 개수형 값은 그대로인 위상 변화는 modeling_error_suspected,
// 위상 묶음이 파라미터당 상한을 넘어 줄인 범위는 topology_group_limit이다. 위상 묶음 안의 단독 스윕이 줄어든 것도 알린다.
import { reaches, type Slider, type Spec } from "../src/engine.ts";
import type { Feedback } from "./feedback.ts";
import type { BundleSweep, Reduction, ShapeRef, UploadBundle } from "./upload-bundle.ts";

/** 파라미터 하나의 위상 묶음 상한(기본 묶음 포함). 애드인의 TOPOLOGY_GROUP_LIMIT와 같다. */
export const TOPOLOGY_GROUP_LIMIT = 4;

const refList = (refs: ShapeRef[]) => refs.map((f) => `${f.body} ${f.name}`).join(", ");

/** 면 구성이 바뀐 까닭을 사람이 읽는 말로 */
function reasonText(r: Reduction): string {
  const changes = [
    ...(r.removed_faces.length > 0 ? [`사라진 면: ${refList(r.removed_faces)}`] : []),
    ...(r.added_faces.length > 0 ? [`생긴 면: ${refList(r.added_faces)}`] : []),
    // 면은 그대로이고 모서리만 바뀐 경우에만 모서리를 적는다. 면이 바뀌면 모서리도 따라 바뀌어 힌트만 길어진다.
    ...(r.removed_faces.length + r.added_faces.length === 0 ? [`바뀐 모서리: ${refList([...r.removed_edges, ...r.added_edges])}`] : []),
  ].join(", ");
  if (r.reason === "modeling_error_suspected") {
    return `${r.at}에서 면 구성이 바뀌었는데(${changes}) 개수형 파라미터 값은 그대로라 모델링 오류가 의심됩니다(면 지정점 등 확인 필요)`;
  }
  const counts = Object.entries(r.counts).map(([name, [from, to]]) => `${name} ${from}→${to}`).join(", ");
  if (r.reason === "topology_group_limit") {
    return `${r.at}에서 개수형 파라미터가 바뀌며(${counts}) 위상 묶음이 ${TOPOLOGY_GROUP_LIMIT}개를 넘습니다(${changes})`;
  }
  return `${r.at}에서 개수형 파라미터가 바뀌며(${counts}) 면 구성이 바뀌었습니다(${changes})`;
}

/**
 * 범위가 줄어든 단독 스윕 하나와 그 스윕의 부품. 위상 묶음 안의 단독 스윕이면 group에 그 묶음의 파라미터와 기준 값이 있다.
 * 부품은 그 스윕의 기준 형상(기본 형상 또는 묶음 기준 형상) 면으로 정해진다.
 */
interface Scope {
  sweep: BundleSweep;
  parts: UploadBundle["parts"];
  faces: UploadBundle["baseline"]["faces"];
  group?: { parameter: string; anchor: number; range: { min: number; max: number } };
}

/** 기본 묶음의 단독 스윕과 위상 묶음 안의 단독 스윕 */
function scopes(bundle: UploadBundle): Scope[] {
  return bundle.sweeps.flatMap((sweep) => [
    { sweep, parts: bundle.parts, faces: bundle.baseline.faces },
    ...(sweep.groups ?? []).flatMap((g) =>
      g.sweeps.map((inner) => ({
        sweep: inner,
        parts: g.parts,
        faces: g.baseline.faces,
        group: { parameter: sweep.parameter, anchor: g.anchor, range: g.range },
      })),
    ),
  ]);
}

/** 바뀐 면(없으면 모서리)이 속한 부품. 부품은 기준 형상 면으로 정해지므로 바디로 찾는다. 기준 형상에 없는 바디는 그 바디 이름이다. */
function partOf({ parts, faces }: Scope, r: Reduction): string {
  const body = [...r.removed_faces, ...r.added_faces, ...r.removed_edges, ...r.added_edges][0]?.body;
  return parts.find((p) => p.faces.some((i) => faces[i].body === body))?.name ?? body ?? "";
}

/** 피드백이 가리키는 곳: 업로드 단계는 명세가 없어 path가 빈 문자열이고, 검증 단계는 슬라이더 범위 끝이다 */
interface Target {
  path: string;
  measured: object;
  hintTail: string;
}

function reductionFeedback(scope: Scope, r: Reduction, { path, measured, hintTail }: Target): Feedback {
  const { sweep, group } = scope;
  const { reason: kind, side, at, removed_faces, added_faces, removed_edges, added_edges, counts } = r;
  const where = group ? `${group.parameter}=${group.anchor} 위상 묶음에서 ` : "";
  return {
    path,
    // 업로드 단계에서도 슬라이더 id가 될 파라미터 이름을 쓴다(슬라이더 id는 부모 파라미터 이름이다)
    slider: sweep.parameter,
    part: partOf(scope, r),
    kind,
    measured: { ...measured, ...(group ? { values: { [group.parameter]: group.anchor } } : {}), at, removed_faces, added_faces, removed_edges, added_edges, counts },
    expected: { [side]: sweep.range[side] },
    hint: `${where}${sweep.parameter}의 스윕 범위는 ${reasonText(r)}. ${side}가 ${sweep.range[side]}까지 줄었습니다.${hintTail}`,
  };
}

/** 업로드 때 운영자에게 알릴 범위 축소 */
export function uploadRangeFeedback(bundle: UploadBundle): Feedback[] {
  return scopes(bundle).flatMap((scope) =>
    (scope.sweep.reductions ?? []).map((r) => reductionFeedback(scope, r, { path: "", measured: {}, hintTail: "" })),
  );
}

/** 슬라이더가 그쪽 끝에서 스윕 범위 밖으로 나가는지 */
const beyond = (slider: Slider, sweep: BundleSweep, side: Reduction["side"]) =>
  side === "min" ? slider.min < sweep.range.min : slider.max > sweep.range.max;

/**
 * 슬라이더 범위가 줄어든 스윕 범위를 넘으면 그쪽 끝을 좁히라는 검증 피드백. 줄지 않은 쪽은 범위 교집합(range-intersection.ts)이 명세 검사로 본다.
 * 위상 묶음 안의 단독 스윕은 묶음의 파라미터가 슬라이더이고 그 슬라이더 범위가 묶음에 닿을 때만 본다.
 */
export function verifyRange(spec: Spec, bundle: UploadBundle): Feedback[] {
  const sliderOf = (id: string) => spec.sliders.find((s) => s.id === id);
  return scopes(bundle).flatMap((scope) => {
    const i = spec.sliders.findIndex((s) => s.id === scope.sweep.parameter);
    if (i === -1) return [];
    if (scope.group) {
      const parent = sliderOf(scope.group.parameter);
      if (!parent || !reaches(parent, scope.group)) return [];
    }
    const slider = spec.sliders[i];
    return (scope.sweep.reductions ?? [])
      .filter((r) => beyond(slider, scope.sweep, r.side))
      .map((r) =>
        reductionFeedback(scope, r, {
          path: `sliders[${i}].${r.side}`,
          measured: { value: slider[r.side] },
          hintTail: ` ${slider.id}의 ${r.side} 값을 ${scope.sweep.range[r.side]}${r.side === "min" ? " 이상으로" : " 이하로"} 좁히세요`,
        }),
      );
  });
}
