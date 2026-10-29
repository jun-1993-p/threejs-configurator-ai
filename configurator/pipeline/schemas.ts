// AI 응답과 업로드 묶음의 JSON Schema 검사. 명세와 업로드 묶음 스키마는 서버(Python)와 같이 쓰는 schema/ 파일이다.
import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

// strictTypes는 끈다. 업로드 묶음 스키마가 allOf 조건 안에서 type 없이 required만 쓰는 것은 의도한 형식이다.
const ajv = new Ajv2020.default({ allErrors: true, strictTypes: false });

const shared = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../schema/${name}`, import.meta.url), "utf-8")) as object;

/** 값이 스키마에 맞으면 빈 목록, 아니면 사람이 읽을 문장 목록 */
export type Check = (value: unknown) => string[];

function checker(schema: object): Check {
  const validate = ajv.compile(schema);
  return (value) =>
    validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "(최상위)"}: ${e.message}`);
}

export const checkUploadBundle = checker(shared("upload-bundle.schema.json"));
export const checkSpec = checker(shared("spec.schema.json"));

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
      front: { enum: ["+X", "-X", "+Y", "-Y", "+Z", "-Z"] },
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
