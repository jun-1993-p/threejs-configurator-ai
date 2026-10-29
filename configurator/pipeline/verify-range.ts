// 줄어든 스윕 범위: 애드인이 범위 끝 쪽의 위상 변화로 줄인 범위를 운영자와 AI에게 알린다(ADR-0005).
// 개수형 값이 함께 바뀐 위상 변화는 range_shrunk, 개수형 값은 그대로인 위상 변화는 modeling_error_suspected다.
import type { Slider, Spec } from "../src/engine.ts";
import type { Feedback } from "./feedback.ts";
import type { Reduction, ShapeRef, UploadBundle } from "./upload-bundle.ts";

type Sweep = UploadBundle["sweeps"][number];

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
  return `${r.at}에서 개수형 파라미터가 바뀌며(${counts}) 면 구성이 바뀌었습니다(${changes})`;
}

/** 바뀐 면(없으면 모서리)이 속한 부품. 부품은 기본 형상 면으로 정해지므로 바디로 찾는다. */
function partOf(bundle: UploadBundle, r: Reduction): string {
  const body = [...r.removed_faces, ...r.added_faces, ...r.removed_edges, ...r.added_edges][0]?.body;
  return bundle.parts.find((p) => p.faces.some((i) => bundle.baseline.faces[i].body === body))?.name ?? "";
}

/** 피드백이 가리키는 곳: 업로드 단계는 명세가 없어 path가 빈 문자열이고, 검증 단계는 슬라이더 범위 끝이다 */
interface Target {
  path: string;
  measured: object;
  hintTail: string;
}

function reductionFeedback(bundle: UploadBundle, sweep: Sweep, r: Reduction, { path, measured, hintTail }: Target): Feedback {
  const { reason: kind, side, at, removed_faces, added_faces, removed_edges, added_edges, counts } = r;
  return {
    path,
    // 업로드 단계에서도 슬라이더 id가 될 파라미터 이름을 쓴다(슬라이더 id는 부모 파라미터 이름이다)
    slider: sweep.parameter,
    part: partOf(bundle, r),
    kind,
    measured: { ...measured, at, removed_faces, added_faces, removed_edges, added_edges, counts },
    expected: { [side]: sweep.range[side] },
    hint: `${sweep.parameter}의 스윕 범위는 ${reasonText(r)}. ${side}가 ${sweep.range[side]}까지 줄었습니다.${hintTail}`,
  };
}

/** 업로드 때 운영자에게 알릴 범위 축소 */
export function uploadRangeFeedback(bundle: UploadBundle): Feedback[] {
  return bundle.sweeps.flatMap((sweep) =>
    (sweep.reductions ?? []).map((r) => reductionFeedback(bundle, sweep, r, { path: "", measured: {}, hintTail: "" })),
  );
}

/** 슬라이더가 그쪽 끝에서 스윕 범위 밖으로 나가는지 */
const beyond = (slider: Slider, sweep: Sweep, side: Reduction["side"]) =>
  side === "min" ? slider.min < sweep.range.min : slider.max > sweep.range.max;

/** 슬라이더 범위가 줄어든 스윕 범위를 넘으면 그쪽 끝을 좁히라는 검증 피드백. 줄지 않은 쪽은 범위 교집합(티켓 14)이 본다. */
export function verifyRange(spec: Spec, bundle: UploadBundle): Feedback[] {
  return spec.sliders.flatMap((slider, i) => {
    const sweep = bundle.sweeps.find((s) => s.parameter === slider.id);
    if (!sweep) return [];
    return (sweep.reductions ?? [])
      .filter((r) => beyond(slider, sweep, r.side))
      .map((r) =>
        reductionFeedback(bundle, sweep, r, {
          path: `sliders[${i}].${r.side}`,
          measured: { value: slider[r.side] },
          hintTail: ` ${slider.id}의 ${r.side} 값을 ${sweep.range[r.side]}${r.side === "min" ? " 이상으로" : " 이하로"} 좁히세요`,
        }),
      );
  });
}
