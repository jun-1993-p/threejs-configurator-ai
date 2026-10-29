// AI 응답과 업로드 묶음의 JSON Schema 검사. 명세와 업로드 묶음 스키마는 서버(Python)와 같이 쓰는 schema/ 파일이다.
import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

import { STANDARD_THICKNESSES, thicknessOptions, type Spec } from "../src/engine.ts";

// strictTypes는 끈다. 업로드 묶음 스키마가 allOf 조건 안에서 type 없이 required만 쓰는 것은 의도한 형식이다.
const ajv = new Ajv2020.default({ allErrors: true, strictTypes: false });

const loadSharedSchema = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../schema/${name}`, import.meta.url), "utf-8")) as object;

/** 정면 방향(Fusion 좌표 기준). 명세의 front와 같은 값이다. */
export const FRONTS = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"] as const;

/** 값이 스키마에 맞으면 빈 목록, 아니면 사람이 읽을 문장 목록 */
export type Check = (value: unknown) => string[];

function checker(schema: object): Check {
  const validate = ajv.compile(schema);
  return (value) =>
    validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "(최상위)"}: ${e.message}`);
}

export const checkUploadBundle = checker(loadSharedSchema("upload-bundle.schema.json"));
export const checkSpec = checker(loadSharedSchema("spec.schema.json"));
/** 추가 샘플 요청에 대한 애드인 응답. 형식은 업로드 묶음 스키마에 함께 있다(위에서 컴파일해 $id로 찾는다). */
export const checkSampleResponse = checker({ $ref: "upload-bundle.schema.json#/$defs/sampleResponse" });

/** 후보 제시 응답. 후보는 2~4개(사용자 스토리 19). */
export const checkCandidates = checker({
  type: "array",
  minItems: 2,
  maxItems: 4,
  items: {
    type: "object",
    required: ["id", "front", "parents", "showThickness", "summary", "diff"],
    additionalProperties: false,
    properties: {
      id: { type: "string", minLength: 1 },
      front: { enum: FRONTS },
      parents: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      showThickness: { type: "boolean" },
      summary: { type: "string" },
      diff: { type: "string" },
    },
  },
});

/** UI 스타일 응답. 저장소의 스타일 목록 밖의 값은 통과하지 못한다(ADR-0001). */
export function styleChoiceChecker(styleIds: string[]): Check {
  return checker({
    type: "object",
    required: ["style"],
    additionalProperties: false,
    properties: { style: { enum: styleIds } },
  });
}

/**
 * 명세가 업로드 묶음의 이름을 맞게 가리키는지. 슬라이더 id는 스윕한 파라미터여야 하고,
 * affects의 부품은 업로드 묶음의 부품이어야 하며, 한 부품이 형태 변경과 위치 이동에 함께 있을 수 없다.
 * JSON Schema 검사를 통과한 명세에 쓴다.
 */
export function specReferenceChecker(bundle: { parts: { name: string }[]; sweeps: { parameter: string }[] }) {
  const parts = new Set(bundle.parts.map((p) => p.name));
  const swept = new Set(bundle.sweeps.map((s) => s.parameter));
  return (spec: { sliders: { id: string; affects: { shape: string[]; move: string[] } }[] }): string[] =>
    spec.sliders.flatMap(({ id, affects }, i) => [
      ...(swept.has(id) ? [] : [`/sliders/${i}/id: ${id}는 스윕한 파라미터가 아닙니다`]),
      ...(["shape", "move"] as const).flatMap((field) =>
        affects[field].filter((part) => !parts.has(part)).map((part) => `/sliders/${i}/affects/${field}: ${part}는 업로드 묶음의 부품이 아닙니다`),
      ),
      ...affects.shape.filter((part) => affects.move.includes(part)).map((part) => `/sliders/${i}/affects: ${part}가 shape와 move에 함께 있습니다`),
    ]);
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

/**
 * 후보가 노출할 부모 파라미터가 슬라이더로 쓸 수 있는 것인지. 스윕한 파라미터여야 하고, 개수형 파라미터는
 * 섞을 수 없으므로 후보가 될 수 없다(ADR-0005). 애드인은 개수형을 스윕하지 않지만 이유를 따로 알린다.
 */
export function candidateReferenceChecker(bundle: { parameters: { name: string; is_count: boolean }[]; sweeps: { parameter: string }[] }) {
  const counts = new Set(bundle.parameters.filter((p) => p.is_count).map((p) => p.name));
  const swept = new Set(bundle.sweeps.map((s) => s.parameter));
  return (candidates: { parents: string[] }[]): string[] =>
    candidates.flatMap(({ parents }, i) =>
      parents.flatMap((parent, k) => {
        const at = `/${i}/parents/${k}`;
        if (counts.has(parent)) return [`${at}: ${parent}는 개수형 파라미터라 슬라이더 후보가 될 수 없습니다`];
        return swept.has(parent) ? [] : [`${at}: ${parent}는 스윕한 파라미터가 아닙니다`];
      }),
    );
}
