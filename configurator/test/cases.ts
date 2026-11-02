// 시험용 사례: 앞서 승인된 서랍장 상품의 결정. 정보 입력만 바꾸고 나머지는 서랍장 합성 녹화본의 명세 그대로다.
import { readFileSync } from "node:fs";

import type { Spec } from "../src/engine.ts";
import type { Candidate, CaseRecord } from "../pipeline/runner.ts";
import type { ProductKind } from "../pipeline/schemas.ts";

const spec: Spec = JSON.parse(readFileSync(new URL("../../fixtures/synthetic/drawer.spec.json", import.meta.url), "utf-8"));

const candidate: Candidate = { id: "c1", front: "-Y", sliders: [{ parameter: "body_w", name: "전체 폭" }], showThickness: false, summary: "전체 폭 하나", diff: "정면 -Y" };

export function pastCase(name: string, memo: string, kind: ProductKind = "서랍장"): CaseRecord {
  return {
    kind,
    intake: { name, kind, memo, thickness: "ai" },
    candidates: [[candidate]],
    chosen: { ...candidate, axes: { W: "X", D: "Y", H: "Z" }, sliders: [{ parameter: "body_w", name: "전체 폭", parent: "body_w" }] },
    spec,
    edits: { body_w: { name: "가로 길이" } },
    rejections: [],
    backToChoice: [],
  };
}
