// AI 응답과 업로드 묶음의 JSON Schema 검사. 명세와 업로드 묶음 스키마는 서버(Python)와 같이 쓰는 schema/ 파일이다.
import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

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
