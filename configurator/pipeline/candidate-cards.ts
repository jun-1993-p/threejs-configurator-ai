// 후보 제시에 붙는 그림: 부품 탐색(VLM)에 보낼 여섯 방향 그림과, 후보 카드의 축 대응·변형 미리보기.
// 미리보기는 업로드한 스윕으로 만든다. 변형 엔진에 부모 파라미터마다 스윕 범위 전체를 슬라이더로 준 임시 명세를 넣는다.
import { createMorph, type Axis, type Spec, type Vector } from "../src/engine.ts";
import { DIMENSIONS } from "./measure.ts";
import { parameterRelations, sweepResponse } from "./parameter-relations.ts";
import { cross, hex, partPalette, renderPngs, type Rgb, type View } from "./render.ts";
import type { Candidate, PartsFound } from "./runner.ts";
import { FRONTS, FUSION_AXES, type Front, type FusionAxis } from "./schemas.ts";
import type { UploadBundle } from "./upload-bundle.ts";

/** 정면 방향이나 위쪽 방향("+X" 등)의 단위 벡터 */
export function directionOf(front: Front): Vector {
  const v: Vector = [0, 0, 0];
  v["XYZ".indexOf(front[1])] = front[0] === "-" ? -1 : 1;
  return v;
}

/** 정면 쪽에서 오른쪽 위로 비켜 본 시점. 후보 카드의 미리보기와 AI 판정 렌더링이 같이 쓴다. */
export function obliqueView(front: Front, up: Front): View {
  const [f, top] = [directionOf(front), directionOf(up)];
  const side = cross(top, f);
  return { eye: [0, 1, 2].map((c) => f[c] + 0.6 * side[c] + 0.5 * top[c]) as Vector, up: top };
}

/** 그림 속 부품마다 칠한 색. VLM에 그림과 같이 보낸다. */
export const partColorsOf = (parts: string[], colorOf: (part: string) => Rgb): PartColor[] =>
  [...new Set(parts)].map((name) => ({ name, color: hex(colorOf(name)) }));

/** 정면과 위쪽에서 정해지는 축 대응: D 깊이는 정면 방향의 축, H 높이는 위쪽의 축, W 폭은 남은 축이다 */
export function axesFor(front: Front, up: Front): Record<Axis, FusionAxis> {
  const [D, H] = [front[1], up[1]] as FusionAxis[];
  if (D === H) throw new Error(`정면 ${front}과 위쪽 ${up}이 같은 축이라 축 대응을 정할 수 없습니다`);
  return { W: FUSION_AXES.find((a) => a !== D && a !== H)!, D, H };
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

/** 슬라이더가 움직일 수 있는 부모 하나와, 그 부모를 움직이면 같이 변하는 다른 치수(예: "전체 폭") */
export interface ParentOption {
  parent: string;
  alsoChanges: string[];
}

/**
 * 후보의 슬라이더 하나와 그 부모 후보. 부모 파라미터면 자기 하나이고, 자식 치수면 수식을 거슬러 닿는 스윕한 파라미터들이라
 * 운영자가 고른다(ADR-0003).
 */
export interface ParentChoice {
  parameter: string;
  name: string;
  options: ParentOption[];
}

/** 운영자에게 보이는 후보 카드: 후보에 정면에 따른 축 대응, 변형 미리보기, 슬라이더마다의 부모 후보를 붙인 것 */
export interface CandidateCard extends Candidate {
  axes: Record<Axis, FusionAxis>;
  previews: Preview[];
  /** 후보의 슬라이더 순서 그대로 */
  choices: ParentChoice[];
}

/**
 * 운영자가 고른 부모(picked)가 그 슬라이더의 부모 후보인지. 부모 후보가 하나면 고르지 않아도 그 부모다.
 * 아니면 운영자에게 보일 오류 문장이다. 후보 선택 양식과 실행기가 같이 쓴다.
 */
export function pickParent({ parameter, name, options }: ParentChoice, picked: string | undefined): { parent: string } | { error: string } {
  const parents = options.map((o) => o.parent);
  const parent = picked ?? (parents.length === 1 ? parents[0] : undefined);
  if (parent !== undefined && parents.includes(parent)) return { parent };
  const outside = parent === undefined ? "" : `. ${parent}는 부모 후보가 아닙니다`;
  return { error: `${name}(${parameter})을 바꾸려고 움직일 부모를 고르세요(${parents.join(", ")})${outside}` };
}

/** W·D·H를 화면에 쓰는 말 */
export const DIMENSION_NAMES: Record<Axis, string> = { W: "폭", D: "깊이", H: "높이" };

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
  return { views, colors: partColorsOf(shape.faces.map((f) => f.part), colorOf) };
}

/**
 * 부모를 움직이면 같이 변하는 다른 치수: 단독 스윕에서 상품 전체와 부품(부품 탐색의 역할 이름)의 W·D·H 치수 중 바뀌는 것에서
 * 슬라이더 자신의 이름(own)을 뺀 것. Fusion 수식은 풀지 않고 스윕이 담은 형상으로만 잰다(ADR-0003).
 */
function alsoChanges(bundle: UploadBundle, parent: string, own: string, axes: Record<Axis, FusionAxis>, roleOf: (part: string) => string): string[] {
  const response = sweepResponse(bundle, parent);
  if (!response) return [];
  const changed = (size: Record<FusionAxis, number>) => DIMENSIONS.filter((a) => size[axes[a]] > 0).map((a) => DIMENSION_NAMES[a]);
  const names = [
    ...changed(response.overall).map((d) => `전체 ${d}`),
    ...response.parts.flatMap(({ part, size }) => changed(size).map((d) => `${roleOf(part)} ${d}`)),
  ];
  return [...new Set(names)].filter((n) => n !== own.trim());
}

/** 후보마다 카드를 만든다. 미리보기는 정면 쪽에서 오른쪽 위로 비켜 본 그림이다. */
export function candidateCards(candidates: Candidate[], bundle: UploadBundle, parts: PartsFound): CandidateCard[] {
  const colorOf = colorsOf(bundle);
  const relations = parameterRelations(bundle);
  const roles = new Map(parts.parts.map((p) => [p.name, p.role]));
  const roleOf = (part: string) => roles.get(part) ?? part;
  return candidates.map((candidate) => {
    const axes = axesFor(candidate.front, parts.up);
    const view = obliqueView(candidate.front, parts.up);
    const choices = candidate.sliders.map(({ parameter, name }) => ({
      parameter,
      name,
      options: relations.parentOptions(parameter).map((parent) => ({ parent, alsoChanges: alsoChanges(bundle, parent, name, axes, roleOf) })),
    }));
    // 미리보기는 움직일 수 있는 부모마다 하나다. 자식 치수는 부모 후보마다 그려 운영자가 비교하고 고른다.
    const parents = [...new Set(choices.flatMap((c) => c.options.map((o) => o.parent)))];
    const spec = sweepSpec(bundle, parents);
    const morph = createMorph(spec, bundle);
    const previews = spec.sliders.map(({ id, min, max, default: value }) => {
      const values = [min, value, max];
      const images = renderPngs(values.map((v) => morph.shape({ [id]: v })), view, PREVIEW_SIZE, colorOf);
      return { parameter: id, values, images: images.map((png) => png.toString("base64")) };
    });
    return { ...candidate, axes, previews, choices };
  });
}
