// AI 응답과 업로드 묶음의 JSON Schema 검사. 명세와 업로드 묶음 스키마는 서버(Python)와 같이 쓰는 schema/ 파일이다.
import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

import { STANDARD_THICKNESSES, thicknessOptions, type Spec } from "../src/engine.ts";
import { SLIDER_SHAPES } from "../src/style.ts";
import { parameterRelations, wordsOf, type BundleParameters } from "./parameter-relations.ts";

// strictTypes는 끈다. 업로드 묶음 스키마가 allOf 조건 안에서 type 없이 required만 쓰는 것은 의도한 형식이다.
const ajv = new Ajv2020.default({ allErrors: true, strictTypes: false });

const loadSharedSchema = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../schema/${name}`, import.meta.url), "utf-8")) as object;

/** 정면 방향(Fusion 좌표 기준). 명세의 front와 같은 값이다. */
export const FRONTS = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"] as const;
export type Front = (typeof FRONTS)[number];

/** Fusion 좌표축. 명세 axes의 값이고, 정면 방향의 둘째 글자다. */
export const FUSION_AXES = ["X", "Y", "Z"] as const;
export type FusionAxis = (typeof FUSION_AXES)[number];

/** 값이 스키마에 맞으면 빈 목록, 아니면 사람이 읽을 문장 목록 */
export type Check = (value: unknown) => string[];

/** 형식 오류 문장에서 응답 전체를 가리키는 위치 */
const ROOT = "(최상위)";

/** JSON으로 읽을 수 없는 AI 응답(문자열)의 형식 오류. 단계마다 응답은 객체나 배열이라 문자열은 늘 형식 오류다. */
export const UNREADABLE_ANSWER = `${ROOT}: JSON으로 읽을 수 없는 답입니다. 설명 없이 JSON 하나만 내세요`;

function checker(schema: object): Check {
  const validate = ajv.compile(schema);
  return (value) =>
    validate(value)
      ? []
      : (validate.errors ?? []).map((e) => {
          // 값 목록 밖이면 고칠 수 있게 고를 수 있는 값을 붙인다
          const allowed = e.keyword === "enum" ? ` (${(e.params as { allowedValues: unknown[] }).allowedValues.join(", ")})` : "";
          return `${e.instancePath || ROOT}: ${e.message}${allowed}`;
        });
}

export const checkUploadBundle = checker(loadSharedSchema("upload-bundle.schema.json"));
/** 명세 JSON Schema. AI에게 출력 형식으로도 알려 준다. */
export const SPEC_SCHEMA = loadSharedSchema("spec.schema.json");
export const checkSpec = checker(SPEC_SCHEMA);
/** 추가 샘플 요청에 대한 애드인 응답. 형식은 업로드 묶음 스키마에 함께 있다(위에서 컴파일해 $id로 찾는다). */
export const checkSampleResponse = checker({ $ref: "upload-bundle.schema.json#/$defs/sampleResponse" });

/** 상품 종류 목록. 사례 저장소와 치수 규칙을 이 값으로 거른다. */
export const PRODUCT_KINDS = ["서랍장", "책장", "선반", "수납장", "테이블", "의자"] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

/** 정보 입력의 두께 선택 노출 여부. ai는 "AI 판단"이다. */
export const THICKNESS_CHOICES = ["ai", "show", "hide"] as const;
export type ThicknessExposure = (typeof THICKNESS_CHOICES)[number];

/** 정보 입력. 직업처럼 쓰이지 않는 항목은 받지 않는다(사용자 스토리 18). */
export const checkIntake = checker({
  type: "object",
  required: ["name", "kind", "memo", "thickness"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
    kind: { enum: PRODUCT_KINDS },
    memo: { type: "string" },
    thickness: { enum: THICKNESS_CHOICES },
  },
});

/** 부품 탐색(VLM) 응답. fronts가 둘 이상이면 정면을 확신하지 못한 것이고, 확신 순서다. */
export const PARTS_SCHEMA = {
  type: "object",
  required: ["parts", "fronts", "up"],
  additionalProperties: false,
  properties: {
    parts: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name", "role"],
        additionalProperties: false,
        properties: { name: { type: "string", minLength: 1 }, role: { type: "string", minLength: 1 } },
      },
    },
    fronts: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { enum: FRONTS } },
    up: { enum: FRONTS },
  },
};
export const checkParts = checker(PARTS_SCHEMA);

/**
 * 후보 제시 응답. 후보는 2~4개(사용자 스토리 19). 슬라이더마다 고객이 보는 치수의 파라미터(parameter)와 그 뜻의 이름(name)이다.
 * parameter가 자식 파라미터면 움직일 부모는 후보 선택에서 운영자가 고른다(ADR-0003).
 */
export const CANDIDATES_SCHEMA = {
  type: "array",
  minItems: 2,
  maxItems: 4,
  items: {
    type: "object",
    required: ["id", "front", "sliders", "showThickness", "summary", "diff"],
    additionalProperties: false,
    properties: {
      id: { type: "string", minLength: 1 },
      front: { enum: FRONTS },
      sliders: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["parameter", "name"],
          additionalProperties: false,
          properties: { parameter: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 } },
        },
      },
      showThickness: { type: "boolean" },
      summary: { type: "string" },
      diff: { type: "string" },
    },
  },
};
export const checkCandidates = checker(CANDIDATES_SCHEMA);

const HEX_COLOR = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };

/**
 * 저장소의 UI 스타일 목록. 고정 코어가 그대로 CSS와 재질 색에 넣으므로, 색은 "#rrggbb"만, 글꼴은 CSS 규칙을 끊는 글자 없이 받는다.
 */
const STYLES_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    required: ["id", "summary", "colors", "font", "slider"],
    additionalProperties: false,
    properties: {
      id: { type: "string", minLength: 1 },
      summary: { type: "string" },
      colors: {
        type: "object",
        required: ["background", "text", "accent", "parts"],
        additionalProperties: false,
        properties: { background: HEX_COLOR, text: HEX_COLOR, accent: HEX_COLOR, parts: { type: "array", minItems: 1, items: HEX_COLOR } },
      },
      font: { type: "string", pattern: "^[^;{}<>\\\\]+$" },
      slider: { enum: SLIDER_SHAPES },
    },
  },
};
export const checkStyles = checker(STYLES_SCHEMA);

/** UI 스타일 응답. 저장소의 스타일 목록 밖의 값은 통과하지 못한다(ADR-0001). */
export function styleChoiceSchema(styleIds: string[]) {
  return {
    type: "object",
    required: ["style"],
    additionalProperties: false,
    properties: { style: { enum: styleIds } },
  };
}

export function styleChoiceChecker(styleIds: string[]): Check {
  return checker(styleChoiceSchema(styleIds));
}

/** AI 판정 응답. 문제는 보낸 렌더링 이름(images)을 가리키고 이유는 한 줄이다. 문제가 없으면 통과다. */
export function judgmentSchema(images: string[]) {
  return {
    type: "object",
    required: ["problems"],
    additionalProperties: false,
    properties: {
      problems: {
        type: "array",
        items: {
          type: "object",
          required: ["image", "reason"],
          additionalProperties: false,
          properties: { image: { enum: images }, reason: { type: "string", pattern: "^[^\\n]+$" } },
        },
      },
    },
  };
}

export function judgmentChecker(images: string[]): Check {
  return checker(judgmentSchema(images));
}

/**
 * 슬라이더 이름에 Fusion 파라미터 이름이 낱말로 들어 있으면(대소문자 무시, "d12 폭"도) 그 오류 문장(사용자 스토리 28).
 * 후보 검사와 명세 검사가 같이 쓴다.
 */
function fusionNameError(at: string, name: string, parameterNames: Set<string>): string[] {
  const lower = new Set([...parameterNames].map((n) => n.toLowerCase()));
  const found = wordsOf(name).filter((w) => lower.has(w.toLowerCase()));
  return found.length > 0
    ? [`${at}: "${name}"에 Fusion 파라미터 이름(${found.join(", ")})이 들어 있습니다. 고객이 보는 치수의 뜻으로 지으세요(예: "서랍 폭"). 이름이 뜻을 말하지 않는 파라미터는 bundle.sweeps의 response(단독 스윕의 축 반응)를 보고 지으세요`]
    : [];
}

/**
 * 명세가 업로드 묶음의 이름을 맞게 가리키는지. 슬라이더 id는 스윕한 파라미터여야 하고, 슬라이더 이름은 Fusion 파라미터 이름이 아니다.
 * children은 수식이 그 슬라이더를 따르는 파라미터여야 한다(기록용이라 변형 엔진은 읽지 않는다, ADR-0003).
 * affects의 부품은 업로드 묶음의 부품이어야 하며, 한 부품이 형태 변경과 위치 이동에 함께 있을 수 없다.
 * JSON Schema 검사를 통과한 명세에 쓴다.
 */
export function specReferenceChecker(bundle: BundleParameters & { parts: { name: string }[] }) {
  const parts = new Set(bundle.parts.map((p) => p.name));
  const swept = new Set(bundle.sweeps.map((s) => s.parameter));
  const parameterNames = new Set(bundle.parameters.map((p) => p.name));
  const relations = parameterRelations(bundle);
  return (spec: { sliders: { id: string; name: string; children: string[]; affects: { shape: string[]; move: string[] } }[] }): string[] =>
    spec.sliders.flatMap(({ id, name, children, affects }, i) => {
      const descendants = relations.descendants(id);
      return [
        ...(swept.has(id) ? [] : [`/sliders/${i}/id: ${id}는 스윕한 파라미터가 아닙니다`]),
        ...fusionNameError(`/sliders/${i}/name`, name, parameterNames),
        ...children
          .filter((child) => !descendants.includes(child))
          .map((child) => `/sliders/${i}/children: ${child}는 수식이 ${id}를 따르지 않습니다(따르는 파라미터: ${descendants.join(", ") || "없음"})`),
        ...(["shape", "move"] as const).flatMap((field) =>
          affects[field].filter((part) => !parts.has(part)).map((part) => `/sliders/${i}/affects/${field}: ${part}는 업로드 묶음의 부품이 아닙니다`),
        ),
        ...affects.shape.filter((part) => affects.move.includes(part)).map((part) => `/sliders/${i}/affects: ${part}가 shape와 move에 함께 있습니다`),
      ];
    });
}

/** 업로드한 모델의 두께와 명세의 두께를 같은 값으로 보는 차이(mm). Fusion 값은 cm에서 바꾼 부동소수다. */
const SAME_THICKNESS_MM = 1e-6;

/** 두께 값 목록을 오류 문장에 쓰는 표기로: "15·18·24" */
const dotted = (values: readonly number[]) => values.join("·");

/**
 * 명세의 두께 선택이 규칙에 맞는지(ADR-0010). JSON Schema 검사를 통과한 명세에 쓴다.
 * - 두께 후보는 표준 두께 목록에서 기본 두께의 앞뒤 한 칸이다(목록 끝은 2개).
 * - ids의 파라미터는 업로드 묶음에 있고 기본 두께가 같으며, 그 값이 default다.
 */
export function thicknessChoiceChecker(bundle: { parameters: { name: string; value: number }[] }) {
  const modelValue = new Map(bundle.parameters.map((p) => [p.name, p.value]));
  return (spec: Pick<Spec, "thickness">): string[] =>
    spec.thickness.flatMap((choice, i) => {
      const at = `/thickness/${i}`;
      const errors = choice.ids.filter((id) => !modelValue.has(id)).map((id) => `${at}/ids: ${id}는 업로드 묶음의 파라미터가 아닙니다`);
      const uploadedIds = choice.ids.filter((id) => modelValue.has(id));
      const values = uploadedIds.map((id) => modelValue.get(id)!);
      if (values.some((v) => Math.abs(v - values[0]) > SAME_THICKNESS_MM)) {
        errors.push(`${at}/ids: 묶인 파라미터의 기본 두께가 다릅니다(${uploadedIds.map((id) => `${id}=${modelValue.get(id)}`).join("·")})`);
      } else if (values.length > 0 && Math.abs(values[0] - choice.default) > SAME_THICKNESS_MM) {
        errors.push(`${at}/default: 업로드한 모델의 두께(${values[0]} mm)와 다릅니다`);
      }
      const options = thicknessOptions(choice.default);
      if (options.length === 0) {
        errors.push(`${at}/default: ${choice.default} mm는 표준 두께 목록(${dotted(STANDARD_THICKNESSES)})에 없습니다`);
      } else if (dotted([...choice.options].sort((a, b) => a - b)) !== dotted(options)) {
        errors.push(`${at}/options: 기본 두께 ${choice.default}의 앞뒤 한 칸(${dotted(options)})이어야 합니다`);
      }
      return errors;
    });
}

/**
 * 정면과 축 대응이 맞는지: 정면 쪽에서 보면 깊이(D)는 정면 방향의 축이고, W·D·H는 서로 다른 Fusion 축이다.
 * 축이 어긋나도 축 반응 검증은 명세의 axes로 재므로 통과할 수 있어, 형식 검사와 함께 본다. JSON Schema 검사를 통과한 명세에 쓴다.
 */
export function axesChecker(spec: Pick<Spec, "front" | "axes">): string[] {
  const { W, D, H } = spec.axes;
  if (new Set([W, D, H]).size < 3) return [`/axes: W·D·H는 서로 다른 축이어야 합니다(W ${W}, D ${D}, H ${H})`];
  const frontAxis = spec.front.slice(1);
  return D === frontAxis ? [] : [`/axes/D: 정면 ${spec.front} 쪽에서 보면 깊이는 ${frontAxis}축입니다(지금 ${D})`];
}

/**
 * 두께 고정: 슬라이더를 움직이는 동안 두께가 변하지 않도록, 고정 두께와 두께 선택의 파라미터는 어떤 슬라이더의 children에도
 * 없어야 한다. 한 파라미터는 고정 두께와 두께 선택 하나 중 한 곳에만 있다. JSON Schema 검사를 통과한 명세에 쓴다.
 */
export function fixedThicknessChecker(spec: Pick<Spec, "sliders" | "thickness" | "fixed">): string[] {
  const childOf = (id: string) => spec.sliders.filter((s) => s.children.includes(id)).map((s) => s.id);
  const choiceOf = (id: string) => spec.thickness.findIndex((t) => t.ids.includes(id));
  return [
    ...spec.fixed.flatMap((id, k) => [
      ...childOf(id).map((slider) => `/fixed/${k}: ${id}는 슬라이더 ${slider}의 children에 있어 고정할 수 없습니다`),
      ...(choiceOf(id) === -1 ? [] : [`/fixed/${k}: ${id}는 thickness[${choiceOf(id)}]의 두께 선택에도 있습니다`]),
    ]),
    ...spec.thickness.flatMap((choice, i) =>
      choice.ids.flatMap((id) => [
        ...childOf(id).map((slider) => `/thickness/${i}/ids: ${id}는 슬라이더 ${slider}의 children에 있어 두께 선택에 둘 수 없습니다`),
        ...(choiceOf(id) < i ? [`/thickness/${i}/ids: ${id}는 thickness[${choiceOf(id)}]의 두께 선택에도 있습니다`] : []),
      ]),
    ),
  ];
}

/** 정면이 위쪽과 같은 축이면 그 오류 문장(at: 오류 위치) */
const frontOnUpAxis = (at: string, front: Front, up: Front) => (front[1] === up[1] ? [`${at}: 위쪽 ${up}와 같은 축이라 정면이 될 수 없습니다`] : []);

/**
 * 부품 탐색 답이 업로드 묶음의 부품을 가리키고, 위쪽이 어느 정면 후보와도 같은 축이 아닌지.
 * JSON Schema 검사를 통과한 답에 쓴다.
 */
export function partsReferenceChecker(bundle: { parts: { name: string }[] }) {
  const parts = new Set(bundle.parts.map((p) => p.name));
  return ({ parts: found, fronts, up }: { parts: { name: string }[]; fronts: Front[]; up: Front }): string[] => [
    ...found.flatMap(({ name }, i) => (parts.has(name) ? [] : [`/parts/${i}/name: ${name}는 업로드 묶음의 부품이 아닙니다`])),
    ...fronts.flatMap((front, i) => frontOnUpAxis(`/fronts/${i}`, front, up)),
  ];
}

/**
 * 후보가 부품 탐색과 정보 입력을 따르고 서로 사실상 같지 않은지(사용자 스토리 17·21·23).
 * - 두 후보는 정면·노출할 부모 파라미터(순서 무관)·두께 선택 노출 중 하나 이상이 달라야 한다.
 * - 부품 탐색이 정면을 확신했으면(정면 후보 하나) 모든 후보가 그 정면이고, 확신하지 못했으면 정면 후보가 모두 후보에 있어야 한다.
 *   위쪽과 같은 축은 정면이 될 수 없다.
 * - 정보 입력이 두께 선택을 보이기나 숨기기로 정했으면 모든 후보가 따른다. "AI 판단"이면 후보마다 다를 수 있다.
 * JSON Schema 검사를 통과한 후보에 쓴다.
 */
export function candidateDiversityChecker({ fronts, up }: { fronts: Front[]; up: Front }, thickness: ThicknessExposure) {
  return (candidates: { id: string; front: Front; sliders: { parameter: string }[]; showThickness: boolean }[]): string[] => {
    const shape = (c: (typeof candidates)[number]) => JSON.stringify([c.front, c.sliders.map((s) => s.parameter).sort(), c.showThickness]);
    const errors = candidates.flatMap((c, i) => [
      ...frontOnUpAxis(`/${i}/front`, c.front, up),
      ...(fronts.length === 1 && c.front !== fronts[0] ? [`/${i}/front: 부품 탐색이 확신한 정면 ${fronts[0]}이어야 합니다`] : []),
      ...(thickness !== "ai" && c.showThickness !== (thickness === "show")
        ? [`/${i}/showThickness: 정보 입력이 두께 선택을 ${thickness === "show" ? "보이기" : "숨기기"}로 정해 ${thickness === "show"}이어야 합니다`]
        : []),
      ...candidates
        .slice(0, i)
        .filter((other) => shape(other) === shape(c))
        .map((other) => `/${i}: 후보 ${other.id}와 정면·부모 파라미터·두께 선택 노출이 모두 같습니다. 하나 이상을 다르게 하세요`),
    ]);
    const missing = fronts.length > 1 ? fronts.filter((f) => !candidates.some((c) => c.front === f)) : [];
    if (missing.length > 0) {
      errors.push(`${ROOT}: 정면을 확신하지 못해(정면 후보 ${fronts.join("·")}) 후보끼리 정면이 달라야 합니다. 빠진 정면: ${missing.join("·")}`);
    }
    return errors;
  };
}

/** 운영자가 고른 후보의 슬라이더: 고객이 보는 치수의 파라미터와 이름, 그리고 움직일 부모(parameter가 부모면 같은 값) */
export interface ChosenSlider {
  parameter: string;
  name: string;
  parent: string;
}

/**
 * 명세가 운영자가 고른 후보를 따르는지: 정면이 후보의 정면이고, W·D·H 축 대응이 후보 카드에 보인 것과 같다.
 * 슬라이더는 고른 부모이고 이름은 카드의 이름이며, 자식 치수를 바꾸는 슬라이더는 children에 그 자식을 적는다(ADR-0003).
 * 범위 교집합이 없으면 슬라이더를 빼라고 하므로, 고른 슬라이더가 모두 있어야 하지는 않다.
 * 축 대응 자체가 틀렸으면(axesChecker) 그 오류만으로 충분해 축 비교는 하지 않는다. JSON Schema 검사를 통과한 명세에 쓴다.
 */
export function chosenCandidateChecker({ front, axes, sliders }: { front: Front; axes: Record<"W" | "D" | "H", FusionAxis>; sliders: ChosenSlider[] }) {
  return (spec: Pick<Spec, "front" | "axes" | "sliders">): string[] => {
    const errors = spec.front === front ? [] : [`/front: 고른 후보의 정면 ${front}이어야 합니다(지금 ${spec.front})`];
    spec.sliders.forEach(({ id, name, children }, i) => {
      const chosen = sliders.find((s) => s.parent === id);
      if (!chosen) {
        errors.push(`/sliders/${i}/id: 고른 후보의 부모 파라미터(${sliders.map((s) => s.parent).join(", ")})가 아닙니다`);
        return;
      }
      if (name !== chosen.name) errors.push(`/sliders/${i}/name: 고른 후보 카드의 이름 "${chosen.name}"이어야 합니다`);
      if (chosen.parameter !== id && !children.includes(chosen.parameter)) {
        errors.push(`/sliders/${i}/children: 이 슬라이더로 바꾸는 치수 ${chosen.parameter}("${chosen.name}")를 적어야 합니다`);
      }
    });
    const axesErrors = axesChecker(spec);
    if (axesErrors.length > 0) return [...errors, ...axesErrors];
    if (spec.front === front && (["W", "D", "H"] as const).some((a) => spec.axes[a] !== axes[a])) {
      errors.push(`/axes: 고른 후보 카드의 축 대응(W ${axes.W}, D ${axes.D}, H ${axes.H})이어야 합니다(지금 W ${spec.axes.W}, D ${spec.axes.D}, H ${spec.axes.H})`);
    }
    return errors;
  };
}

/**
 * 후보의 슬라이더가 슬라이더로 쓸 수 있는 치수인지. 파라미터는 스윕한 것이거나, 수식으로 스윕한 부모를 따르는 자식이어야 한다
 * (자식이면 운영자가 부모를 고른다, ADR-0003). 개수형 파라미터는 섞을 수 없으므로 후보가 될 수 없다(ADR-0005).
 * 한 후보 안에서 같은 파라미터를 두 번 쓰지 않고, 자식의 부모 후보가 모두 그 후보의 다른 슬라이더면 움직일 부모가 없다.
 * 슬라이더 이름은 Fusion 파라미터 이름이 아니다(사용자 스토리 28).
 */
export function candidateReferenceChecker(bundle: BundleParameters) {
  const counts = new Set(bundle.parameters.filter((p) => p.is_count).map((p) => p.name));
  const parameterNames = new Set(bundle.parameters.map((p) => p.name));
  const relations = parameterRelations(bundle);
  /** 후보의 k번째 슬라이더 파라미터가 슬라이더로 쓸 수 없는 까닭. 쓸 수 있으면 빈 목록이다. */
  function parameterErrors(sliders: { parameter: string }[], k: number): string[] {
    const { parameter } = sliders[k];
    if (sliders.findIndex((s) => s.parameter === parameter) < k) return [`${parameter}를 이 후보에서 이미 썼습니다`];
    if (counts.has(parameter)) return [`${parameter}는 개수형 파라미터라 슬라이더 후보가 될 수 없습니다`];
    if (!parameterNames.has(parameter)) return [`${parameter}는 업로드 묶음의 파라미터가 아닙니다`];
    const options = relations.parentOptions(parameter);
    if (options.length === 0) return [`${parameter}는 스윕한 파라미터가 아니고, 수식으로 따르는 스윕한 부모도 없습니다`];
    const others = sliders.map((s) => s.parameter).filter((p) => p !== parameter && relations.sliderable(p));
    return options.every((o) => others.includes(o)) ? [`${parameter}를 바꿀 부모(${options.join(", ")})가 모두 이 후보의 다른 슬라이더입니다`] : [];
  }
  return (candidates: { sliders: { parameter: string; name: string }[] }[]): string[] =>
    candidates.flatMap(({ sliders }, i) =>
      sliders.flatMap(({ name }, k) => [
        ...parameterErrors(sliders, k).map((e) => `/${i}/sliders/${k}/parameter: ${e}`),
        ...fusionNameError(`/${i}/sliders/${k}/name`, name, parameterNames),
      ]),
    );
}

/** 최종 승인에서 반려하며 적은 거절 이유가 한 줄인지. 실행기와 최종 승인 화면이 같이 쓴다. */
export function rejectionReasonErrors(reason: string): string[] {
  const line = reason.trim();
  return line === "" || line.includes("\n") ? ["/reason: 거절 이유를 한 줄로 적으세요"] : [];
}

/** 최종 승인에서 고친 슬라이더: 슬라이더 id → 새 이름·좁힌 범위. 적지 않은 값은 그대로다(사용자 스토리 69·70). */
export type SliderEdits = Record<string, { name?: string; min?: number; max?: number }>;

/** 값이 기본값에서 step의 배수만큼 떨어졌는지. 고정 코어의 슬라이더는 min에서 step씩 움직이므로, 아니면 기본값을 고를 수 없다. */
const onStep = (value: number, { default: base, step }: { default: number; step: number }) => {
  const k = (base - value) / step;
  return Math.abs(k - Math.round(k)) < 1e-9;
};

/**
 * 최종 승인에서 고친 슬라이더가 승인 전 명세 안에서만 바뀌는지. 범위는 좁히기만 한다(사용자 스토리 70):
 * 검증은 승인 전 범위에서 했고, 기본값은 업로드한 모델의 값이라 범위 안에 남고 슬라이더로 고를 수 있어야 한다.
 */
export function approvalEditChecker(approved: Pick<Spec, "sliders">) {
  return (edits: SliderEdits): string[] =>
    Object.entries(edits).flatMap(([id, { name, min, max }]) => {
      const slider = approved.sliders.find((s) => s.id === id);
      if (!slider) return [`/${id}: 명세에 없는 슬라이더입니다(${approved.sliders.map((s) => s.id).join(", ")})`];
      const errors: string[] = [];
      if (name !== undefined && (name.trim() === "" || name.includes("\n"))) errors.push(`/${id}/name: 슬라이더 이름을 한 줄로 적으세요`);
      const range = { min, max };
      const unreadable = (["min", "max"] as const).filter((k) => range[k] !== undefined && !Number.isFinite(range[k]));
      if (unreadable.length > 0) return [...errors, ...unreadable.map((k) => `/${id}/${k}: 숫자로 적으세요`)];
      const { default: base, step } = slider;
      const [newMin, newMax] = [min ?? slider.min, max ?? slider.max];
      const near = (value: number) => {
        const k = Math.floor((base - value) / step);
        return `${base - (k + 1) * step}, ${base - k * step}`;
      };
      if (newMin < slider.min) errors.push(`/${id}/min: 범위는 좁히기만 할 수 있습니다. ${slider.min} 이상으로 적으세요`);
      else if (newMin > base) errors.push(`/${id}/min: 기본값 ${base}(업로드한 모델의 값)이 범위 안에 남도록 ${base} 이하로 적으세요`);
      else if (min !== undefined && !onStep(newMin, slider)) errors.push(`/${id}/min: 기본값 ${base}에서 step ${step}의 배수만큼 떨어진 값으로 적으세요(예: ${near(newMin)})`);
      if (newMax > slider.max) errors.push(`/${id}/max: 범위는 좁히기만 할 수 있습니다. ${slider.max} 이하로 적으세요`);
      else if (newMax < base) errors.push(`/${id}/max: 기본값 ${base}(업로드한 모델의 값)이 범위 안에 남도록 ${base} 이상으로 적으세요`);
      else if (max !== undefined && !onStep(newMax, slider)) errors.push(`/${id}/max: 기본값 ${base}에서 step ${step}의 배수만큼 떨어진 값으로 적으세요(예: ${near(newMax)})`);
      if (errors.length === 0 && newMin === newMax) errors.push(`/${id}/max: ${newMin + step} 이상으로 적으세요. 범위가 한 값뿐이면 슬라이더를 움직일 수 없습니다`);
      return errors;
    });
}
