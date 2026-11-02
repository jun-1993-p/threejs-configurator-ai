// 후보 제시에 붙는 그림: 부품 탐색(VLM)에 보낼 여섯 방향 그림과, 후보 카드의 축 대응·변형 미리보기.
// 미리보기는 업로드한 스윕으로 만든다. 변형 엔진에 부모 파라미터마다 스윕 범위 전체를 슬라이더로 준 임시 명세를 넣는다.
import { createMorph, type Axis, type Spec, type Vector } from "../src/engine.ts";
import { cross, hex, partPalette, renderPngs, type View } from "./render.ts";
import type { Candidate } from "./runner.ts";
import { FRONTS, type Front } from "./schemas.ts";
import type { UploadBundle } from "./upload-bundle.ts";

/** 정면 방향이나 위쪽 방향("+X" 등)의 단위 벡터 */
export function directionOf(front: Front): Vector {
  const v: Vector = [0, 0, 0];
  v["XYZ".indexOf(front[1])] = front[0] === "-" ? -1 : 1;
  return v;
}

/** 정면과 위쪽에서 정해지는 축 대응: D 깊이는 정면 방향의 축, H 높이는 위쪽의 축, W 폭은 남은 축이다 */
export function axesFor(front: Front, up: Front): Record<Axis, string> {
  const [D, H] = [front[1], up[1]];
  if (D === H) throw new Error(`정면 ${front}과 위쪽 ${up}이 같은 축이라 축 대응을 정할 수 없습니다`);
  return { W: [..."XYZ"].find((a) => a !== D && a !== H)!, D, H };
}

/** 부품 탐색(VLM)에 보내는 그림 하나: from 쪽에서 본 직교 투영(PNG, base64) */
export interface PartView {
  from: Front;
  image: string;
}

/** 그림에서 부품을 가리는 색 */
export interface PartColor {
  name: string;
  color: string;
}

/** 후보 카드의 변형 미리보기: 부모 파라미터 하나를 스윕 범위 끝·기본값에 둔 그림(PNG, base64). 나머지는 기본값이다. */
export interface Preview {
  parameter: string;
  values: number[];
  images: string[];
}

/** 운영자에게 보이는 후보 카드: 후보에 정면에 따른 축 대응과 변형 미리보기를 붙인 것 */
export interface CandidateCard extends Candidate {
  axes: Record<Axis, string>;
  previews: Preview[];
}

const VIEW_SIZE = { width: 320, height: 240 };
const PREVIEW_SIZE = { width: 200, height: 150 };

/** 부모 파라미터마다 스윕 범위 전체를 슬라이더로 둔 임시 명세. 엔진은 슬라이더의 id·default·범위만 읽는다. */
function sweepSpec(bundle: UploadBundle, parameters: string[]): Spec {
  const value = new Map(bundle.parameters.map((p) => [p.name, p.value]));
  const sliders = parameters.map((id) => {
    const { range } = bundle.sweeps.find((s) => s.parameter === id)!;
    return { id, name: id, axis: "W" as const, ...range, default: value.get(id)!, step: 1, unit: "mm", source: "", children: [], affects: { shape: [], move: [] } };
  });
  return { product: "", front: "-Y", axes: { W: "X", D: "Y", H: "Z" }, sliders, thickness: [], fixed: [] };
}

const colorsOf = (bundle: UploadBundle) => partPalette(bundle.parts.map((p) => p.name));

/** 기본 형상을 여섯 방향에서 본 그림과 부품 색. X·Y 쪽 그림은 Z가 위, Z 쪽 그림은 Y가 위다. */
export function partViews(bundle: UploadBundle): { views: PartView[]; colors: PartColor[] } {
  const colorOf = colorsOf(bundle);
  const shape = createMorph(sweepSpec(bundle, []), bundle).shape({});
  const views = FRONTS.map((from) => {
    const view: View = { eye: directionOf(from), up: from[1] === "Z" ? [0, 1, 0] : [0, 0, 1] };
    return { from, image: renderPngs([shape], view, VIEW_SIZE, colorOf)[0].toString("base64") };
  });
  const parts = [...new Set(shape.faces.map((f) => f.part))];
  return { views, colors: parts.map((name) => ({ name, color: hex(colorOf(name)) })) };
}

/** 후보마다 카드를 만든다. 미리보기는 정면 쪽에서 오른쪽 위로 비켜 본 그림이다. */
export function candidateCards(candidates: Candidate[], bundle: UploadBundle, up: Front): CandidateCard[] {
  const colorOf = colorsOf(bundle);
  return candidates.map((candidate) => {
    const [front, top] = [directionOf(candidate.front), directionOf(up)];
    const side = cross(top, front);
    const view: View = { eye: [0, 1, 2].map((c) => front[c] + 0.6 * side[c] + 0.5 * top[c]) as Vector, up: top };
    const spec = sweepSpec(bundle, candidate.parents);
    const morph = createMorph(spec, bundle);
    const previews = spec.sliders.map(({ id, min, max, default: value }) => {
      const values = [min, value, max];
      const images = renderPngs(values.map((v) => morph.shape({ [id]: v })), view, PREVIEW_SIZE, colorOf);
      return { parameter: id, values, images: images.map((png) => png.toString("base64")) };
    });
    return { ...candidate, axes: axesFor(candidate.front, up), previews };
  });
}
