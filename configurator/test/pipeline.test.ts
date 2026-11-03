// 경계 1: 상품 하나를 처리하는 파이프라인 실행. 입력은 서랍장 합성 녹화본, 정보 입력, 사람 결정 각본이다.
// AI는 각본대로 답하는 가짜, 저장소는 메모리 구현이다. Fusion 연결은 슬라이더가 하나면 호출되면 실패하는 가짜,
// 둘 이상이면 녹화한 교차 검증 샘플로 답하는 가짜다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { inflateSync } from "node:zlib";

import type { Spec } from "../src/engine.ts";
import type { CandidateCard } from "../pipeline/candidate-cards.ts";
import type { Feedback } from "../pipeline/feedback.ts";
import { FUSION_NEEDED, FUSION_RECONNECTED, runPipeline, type Candidate, type CaseRecord, type FusionPort, type PartsFound, type HumanPort, type Intake, type SampleRequest } from "../pipeline/runner.ts";
import { scriptedAi, type Script } from "../pipeline/scripted-ai.ts";
import { memoryStore } from "../pipeline/memory-store.ts";
import { recordOf } from "../pipeline/case-store.ts";
import { judgeRun } from "../pipeline/final-check.ts";
import { pastCase } from "./cases.ts";
import { UI_STYLES } from "../pipeline/ui-styles.ts";
import type { Style } from "../src/style.ts";
import type { DimensionRule } from "../pipeline/range-intersection.ts";
import {
  crossCorners,
  crossDepth,
  crossThree,
  depthSpec,
  gridDepth,
  gridDepthChecks,
  mixedThicknessRecording,
  mixedThicknessSamples,
  pushMaxSide,
  ratioThicknessRecording,
  shellPointRecording,
  shelfCrossCorners,
  shelfRecording,
  shelfSpec,
  shelfThicknessCross,
  shelfThicknessSamples,
  shelfThicknessSpec,
  threeSpec,
  widthHeightSpec,
} from "./recording.ts";
import type { CrossSample } from "../pipeline/verify-cross.ts";

const fixtures = new URL("../../fixtures/synthetic/", import.meta.url);
const bundle = JSON.parse(readFileSync(new URL("drawer.json", fixtures), "utf-8"));
const spec: Spec = JSON.parse(readFileSync(new URL("drawer.spec.json", fixtures), "utf-8"));

// 메모의 폭은 범위를 스윕 끝(900)까지 넓힌 "틀린 명세"가 수치 검증까지 가도록 900까지 둔다.
const intake: Intake = { name: "1단 서랍장", kind: "서랍장", memo: "폭 400~900, 높이는 고정", thickness: "ai" };

/** 시험용 치수 규칙. 범위는 녹화본 명세들이 모두 들어가게 넉넉히 잡았다. */
const rules: DimensionRule[] = [
  { id: "치수규칙/서랍장/폭", kind: "서랍장", part: "폭", axis: "W", min: 300, max: 1200, origin: "시험용" },
  { id: "치수규칙/서랍장/깊이", kind: "서랍장", part: "깊이", axis: "D", min: 250, max: 700, origin: "시험용" },
  { id: "치수규칙/서랍장/서랍_깊이", kind: "서랍장", part: "서랍 깊이", axis: "D", min: 200, max: 650, origin: "시험용" },
  { id: "치수규칙/서랍장/높이", kind: "서랍장", part: "높이", axis: "H", min: 300, max: 1200, origin: "시험용" },
  { id: "치수규칙/선반/폭", kind: "선반", part: "폭", axis: "W", min: 400, max: 1800, origin: "시험용" },
  { id: "치수규칙/선반/깊이", kind: "선반", part: "깊이", axis: "D", min: 150, max: 600, origin: "시험용" },
];

const candidates: Candidate[] = [
  { id: "c1", front: "-Y", sliders: [{ parameter: "body_w", name: "전체 폭" }], showThickness: false, summary: "전체 폭 하나", diff: "정면 -Y" },
  { id: "c2", front: "+Y", sliders: [{ parameter: "body_w", name: "전체 폭" }], showThickness: false, summary: "전체 폭 하나", diff: "정면 +Y" },
];

/** 부품 탐색(VLM) 답: 정면이 -Y인지 +Y인지 확신하지 못해, 위 두 후보가 그 정면을 나눠 갖는다 */
const partsFound: PartsFound = {
  parts: [
    { name: "Carcass", role: "몸통" },
    { name: "DrawerBox", role: "서랍" },
  ],
  fronts: ["-Y", "+Y"],
  up: "+Z",
};

/** 칸막이 선반 녹화본의 부품 탐색 답 */
const shelfParts: PartsFound = {
  parts: [
    { name: "Carcass", role: "몸통" },
    { name: "Divider", role: "칸막이" },
  ],
  fronts: ["-Y"],
  up: "+Z",
};

const styles = UI_STYLES;

/** AI 판정 답. 문제가 없으면 통과다. */
const judged = (...problems: { image: string; reason: string }[]) => ({ problems });

const offline: FusionPort = {
  requestSamples: () => Promise.reject(new Error("이 시험에서는 추가 샘플을 요청하지 않는다")),
  reconnected: () => Promise.reject(new Error("이 시험에서는 연결을 기다리지 않는다")),
};

/** 녹화한 교차 검증 샘플로 답하는 Fusion 연결. 받은 요청을 남긴다. */
function recordedFusion(samples: CrossSample[] = crossCorners) {
  const requests: SampleRequest[] = [];
  const port: FusionPort = {
    requestSamples: async (request) => {
      requests.push(structuredClone(request));
      const answered = request.values.map((values) => samples.find((s) => JSON.stringify(s.values) === JSON.stringify(values)));
      if (answered.includes(undefined)) throw new Error(`녹화하지 않은 값 묶음: ${JSON.stringify(request.values)}`);
      return { status: "answered", response: { samples: structuredClone(answered) } };
    },
    reconnected: () => Promise.reject(new Error("이 Fusion 연결은 끊기지 않는다")),
  };
  return { port, requests };
}

const approveFirst: HumanPort = {
  chooseCandidate: () => Promise.resolve({ candidate: "c1" }),
  finalApproval: () => Promise.resolve({ decision: "approve" }),
};

/** 스윕한 파라미터. 일부러 틀린 슬라이더 이름을 쓴 명세는 후보에 넣지 않으려고 쓴다. */
const swept = new Set([...bundle.sweeps, ...shelfRecording.sweeps].map((s: { parameter: string }) => s.parameter));

/** 위 두 후보가 각본의 명세들이 쓰는 슬라이더를 모두 노출하게 한 것. 명세의 슬라이더는 고른 후보의 것이어야 한다. */
function candidatesFor(specs: unknown[]): Candidate[] {
  const sliders = new Map<string, string>();
  for (const { id, name } of (specs as Spec[]).flatMap((s) => s.sliders)) if (swept.has(id) && !sliders.has(id)) sliders.set(id, name);
  return candidates.map((c) => ({ ...c, sliders: [...sliders].map(([parameter, name]) => ({ parameter, name })) }));
}

function setup(script: Partial<Script> = {}, fusion: FusionPort = offline, dimensionRules: DimensionRule[] = rules) {
  const ai = scriptedAi({ parts: [partsFound], candidates: [candidatesFor(script.spec ?? [spec])], style: [{ style: "natural" }], spec: [spec], judgment: [judged()], ...script });
  const store = memoryStore({ styles, rules: dimensionRules });
  return { ai, store, ports: { fusion, ai, store } };
}

test("업로드부터 제출까지 정해진 순서로만 진행한다", async () => {
  const { store, ports } = setup();

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  assert.deepEqual(
    store.log.map((e) => e.stage),
    ["upload", "intake", "candidates", "choice", "style", "spec", "assembly", "verification", "approval", "submission"],
  );
});

test("최종 승인에서 승인하면 고정 코어·명세·스윕 데이터·스타일 선택으로 된 결과물이 제출된다", async () => {
  const { store, ports } = setup();

  await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(store.submissions.length, 1);
  const { product, files } = store.submissions[0];
  assert.equal(product, "1단 서랍장");
  assert.deepEqual(JSON.parse(files["spec.json"]), spec);
  assert.deepEqual(JSON.parse(files["sweeps.json"]).sweeps.map((s: { parameter: string }) => s.parameter), ["body_w"]);
  assert.match(files["index.html"], /<div data-configurator data-spec="spec\.json" data-sweeps="sweeps\.json" data-style="style\.json"><\/div>/);
  // 제출된 고정 코어가 제출된 명세·스윕 데이터로 서랍장을 만든다
  const context = vm.createContext({});
  vm.runInContext(files["configurator.js"], context);
  const morph = vm.runInContext("Configurator", context).createMorph(
    JSON.parse(files["spec.json"]),
    JSON.parse(files["sweeps.json"]),
  );
  assert.equal(morph.positions({ body_w: 500 }).length, morph.faces.reduce((n: number, f: { count: number }) => n + f.count, 0) * 3);
});

test("승인된 결정이 사례로 기록된다", async () => {
  const { store, ports } = setup();

  await runPipeline({ bundle, intake, human: approveFirst, ports });

  const [{ id, chosen, ...record }, ...rest] = await store.cases.list();
  assert.deepEqual(rest, []);
  assert.equal(typeof id, "string");
  assert.deepEqual(record, { kind: "서랍장", intake, candidates: [candidates], spec, edits: {}, rejections: [], backToChoice: [] });
  assert.deepEqual([chosen.id, chosen.sliders], ["c1", [{ parameter: "body_w", name: "전체 폭", parent: "body_w" }]]);
});

test("사례에는 회차마다 제시된 후보, 거절 이유, 최종 승인 때 고친 내용이 함께 남는다", async () => {
  const reason = "정면을 반대로 보고 싶다";
  const edits = { body_w: { name: "가로 길이", max: 800 } };
  const { human } = deciding(["c1", "c2"], [{ decision: "reject", back: "candidates", reason }, { decision: "approve", edits }]);
  const second = candidates.map((c) => ({ ...c, summary: `다시 낸 ${c.summary}` }));
  const plusY = { ...spec, front: "+Y", axes: { W: "X", D: "Y", H: "Z" } };
  const { store, ports } = setup({
    candidates: [candidates, second],
    style: [{ style: "natural" }, { style: "natural" }],
    spec: [spec, plusY],
    judgment: [judged(), judged()],
  });

  await runPipeline({ bundle, intake, human, ports });

  const [stored] = await store.cases.list();
  assert.deepEqual(stored.candidates, [candidates, second]);
  assert.equal(stored.chosen.id, "c2");
  assert.deepEqual(stored.rejections.map((r) => [r.candidate.id, r.reason]), [["c1", reason]]);
  assert.deepEqual(stored.edits, edits);
  assert.deepEqual(stored.spec.sliders[0], { ...plusY.sliders[0], name: "가로 길이", max: 800 });
});

test("후보 제시·명세 작성·AI 판정에 같은 상품 종류의 사례 중 정보 입력이 비슷한 3개가 예시로 들어간다", async () => {
  const { ai, store, ports } = setup();
  for (const past of [
    pastCase("원목 협탁", "깊이만 바꾸고 싶음"),
    pastCase("3단 서랍장", "폭 500~900"),
    pastCase("1단 서랍장", "폭 400~900, 높이는 고정"),
    pastCase("2단 서랍장", "폭 400~800, 높이는 고정"),
    // 정보 입력은 지금 상품과 같지만 상품 종류가 다르다
    pastCase("1단 서랍장", "폭 400~900, 높이는 고정", "책장"),
  ]) {
    await store.cases.record(past);
  }

  await runPipeline({ bundle, intake, human: approveFirst, ports });

  const names = (calls: unknown[]) => (calls[0] as { examples: CaseRecord[] }).examples.map((e) => [e.kind, e.intake.name]);
  const expected = [
    ["서랍장", "1단 서랍장"],
    ["서랍장", "2단 서랍장"],
    ["서랍장", "3단 서랍장"],
  ];
  assert.deepEqual(names(ai.calls.candidates), expected);
  assert.deepEqual(names(ai.calls.spec), expected);
  assert.deepEqual(names(ai.calls.judgment), expected);
});

test("승인된 사례는 다음 상품부터 예시로 들어가고, 사례를 빼면 그다음 상품부터 나오지 않는다", async () => {
  const store = memoryStore({ styles, rules });
  const run = async () => {
    const ai = scriptedAi({ parts: [partsFound], candidates: [candidates], style: [{ style: "natural" }], spec: [spec], judgment: [judged()] });
    await runPipeline({ bundle, intake, human: approveFirst, ports: { fusion: offline, ai, store } });
    return (ai.calls.spec[0] as { examples: CaseRecord[] }).examples;
  };

  assert.deepEqual(await run(), []);
  const [first] = await store.cases.list();
  assert.deepEqual(await run(), [recordOf(first)]);
  // 두 번째 상품의 사례는 남기고 첫 상품의 사례만 뺀다
  const [, second] = await store.cases.list();
  await store.cases.remove(first.id);
  assert.deepEqual(await run(), [recordOf(second)]);
});

/** 미리보기 PNG(base64)에서 배경이 아닌 픽셀이 차지하는 가로 폭(픽셀). 렌더러는 필터 없는 8비트 RGB로 쓴다. */
function drawnWidth(base64: string): number {
  const png = Buffer.from(base64, "base64");
  assert.deepEqual([...png.subarray(1, 4)], [...Buffer.from("PNG")]);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat = png.indexOf("IDAT");
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  let [left, right] = [width, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = y * (width * 3 + 1) + 1 + x * 3;
      if (raw[k] === 244 && raw[k + 1] === 244 && raw[k + 2] === 242) continue;
      [left, right] = [Math.min(left, x), Math.max(right, x)];
    }
  }
  return right - left + 1;
}

/** 받은 후보 카드를 남기고 정해 둔 후보를 고르는 사람 */
function choosing(id: string, parents?: Record<string, string>) {
  const shown: CandidateCard[][] = [];
  const human: HumanPort = {
    chooseCandidate: (cards) => {
      shown.push(cards);
      return Promise.resolve({ candidate: id, ...(parents ? { parents } : {}) });
    },
    finalApproval: () => Promise.resolve({ decision: "approve" }),
  };
  return { human, shown };
}

test("후보 제시 전에 VLM이 기본 형상을 여섯 방향에서 본 그림과 부품 색으로 부품 탐색을 한 번 한다", async () => {
  const { ai, ports } = setup();

  await runPipeline({ bundle, intake, human: approveFirst, ports });

  const [asked] = ai.calls.parts as { views: { from: string; image: string }[]; colors: { name: string; color: string }[] }[];
  assert.equal(ai.calls.parts.length, 1);
  assert.deepEqual(asked.views.map((v) => v.from), ["+X", "-X", "+Y", "-Y", "+Z", "-Z"]);
  assert.ok(asked.views.every((v) => drawnWidth(v.image) > 100));
  assert.deepEqual(asked.colors.map((c) => c.name), ["Carcass", "DrawerBox"]);
  assert.notEqual(asked.colors[0].color, asked.colors[1].color);
  // 후보 제시는 부품 탐색 결과를 입력으로 받는다
  assert.deepEqual((ai.calls.candidates[0] as { parts: PartsFound }).parts, partsFound);
});

test("부품이 여섯 개를 넘어도 부품 탐색 그림의 부품 색은 모두 다르다", async () => {
  // 서랍장 녹화본의 면을 부품 여덟 개로 나눈다
  const manyParts = structuredClone(bundle);
  const faces = manyParts.parts.flatMap((p: { faces: number[] }) => p.faces);
  manyParts.parts = Array.from({ length: 8 }, (_, i) => ({ ...manyParts.parts[0], name: `P${i}`, faces: faces.filter((_: number, k: number) => k % 8 === i) }));
  // 명세는 서랍장의 부품 이름을 가리켜 형식 검사를 끝내 통과하지 못하고 멈춘다. 이 시험은 부품 탐색 입력만 본다.
  const { ai, ports } = setup({ parts: [{ ...partsFound, parts: [{ name: "P0", role: "몸통" }] }], spec: [spec, spec, spec, spec] });

  await runPipeline({ bundle: manyParts, intake, human: approveFirst, ports });

  const colors = (ai.calls.parts[0] as { colors: { name: string; color: string }[] }).colors;
  assert.equal(colors.length, 8);
  assert.equal(new Set(colors.map((c) => c.color)).size, 8);
});

test("부품 탐색이 업로드 묶음에 없는 부품을 가리키거나 위쪽과 같은 축을 정면으로 내면 다시 묻는다", async () => {
  const wrong = { ...partsFound, parts: [{ name: "Door", role: "문" }], fronts: ["-Y", "+Z"] };
  const { ai, ports } = setup({ parts: [wrong, partsFound] });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  assert.deepEqual((ai.calls.parts[1] as { schemaErrors: string[] }).schemaErrors, [
    "/parts/0/name: Door는 업로드 묶음의 부품이 아닙니다",
    "/fronts/1: 위쪽 +Z와 같은 축이라 정면이 될 수 없습니다",
  ]);
});

test("후보끼리 정면·부모 파라미터·두께 선택 노출이 모두 같으면 다시 만든다", async () => {
  // 부모 파라미터 순서만 다른 후보도 같은 후보다
  const same = [
    { ...candidates[0], sliders: [{ parameter: "body_w", name: "전체 폭" }, { parameter: "body_h", name: "전체 높이" }] },
    { ...candidates[0], id: "c2", sliders: [{ parameter: "body_h", name: "전체 높이" }, { parameter: "body_w", name: "전체 폭" }], diff: "순서만 다름" },
  ];
  const { ai, ports } = setup({ parts: [{ ...partsFound, fronts: ["-Y"] }], candidates: [same, [candidates[0], { ...candidates[0], id: "c2", showThickness: true }]] });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  assert.deepEqual((ai.calls.candidates[1] as { schemaErrors: string[] }).schemaErrors, [
    "/1: 후보 c1와 정면·부모 파라미터·두께 선택 노출이 모두 같습니다. 하나 이상을 다르게 하세요",
  ]);
});

test("VLM이 정면을 확신하지 못하면 후보끼리 정면 후보를 모두 나눠 갖게 다시 만든다", async () => {
  const unsure: PartsFound = { ...partsFound, fronts: ["-Y", "+X"] };
  const allMinusY = [candidates[0], { ...candidates[0], id: "c2", showThickness: true, diff: "두께 선택 노출" }];
  const split = [candidates[0], { ...candidates[0], id: "c2", front: "+X", diff: "정면 +X" }];
  const { ai, ports } = setup({ parts: [unsure], candidates: [allMinusY, split] });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  assert.deepEqual((ai.calls.candidates[1] as { schemaErrors: string[] }).schemaErrors, [
    "(최상위): 정면을 확신하지 못해(정면 후보 -Y·+X) 후보끼리 정면이 달라야 합니다. 빠진 정면: +X",
  ]);
});

test("VLM이 정면을 확신하면 모든 후보가 그 정면이어야 한다", async () => {
  const sure: PartsFound = { ...partsFound, fronts: ["-Y"] };
  const thicknessSplit = [candidates[0], { ...candidates[0], id: "c2", showThickness: true, diff: "두께 선택 노출" }];
  const { ai, ports } = setup({ parts: [sure], candidates: [candidates, thicknessSplit] });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  assert.deepEqual((ai.calls.candidates[1] as { schemaErrors: string[] }).schemaErrors, ["/1/front: 부품 탐색이 확신한 정면 -Y이어야 합니다"]);
});

test("정보 입력이 두께 선택을 숨기기로 정하면 두께 선택을 보이는 후보는 다시 만든다", async () => {
  const thicknessSplit = [candidates[0], { ...candidates[1], showThickness: true, diff: "정면 +Y, 두께 선택 노출" }];
  const { ai, ports } = setup({ candidates: [thicknessSplit, candidates] });

  const result = await runPipeline({ bundle, intake: { ...intake, thickness: "hide" }, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  assert.deepEqual((ai.calls.candidates[1] as { schemaErrors: string[] }).schemaErrors, [
    "/1/showThickness: 정보 입력이 두께 선택을 숨기기로 정해 false이어야 합니다",
  ]);
});

test("후보 카드마다 다른 후보와의 차이, 정면에 따른 W·D·H 축 대응, 업로드 스윕으로 만든 변형 미리보기가 붙는다", async () => {
  const sideways = [candidates[0], { ...candidates[0], id: "c2", front: "+X", diff: "정면 +X" }];
  const { ports } = setup({ parts: [{ ...partsFound, fronts: ["-Y", "+X"] }], candidates: [sideways] });
  const { human, shown } = choosing("c1");

  await runPipeline({ bundle, intake, human, ports });

  const [cards] = shown;
  assert.deepEqual(
    cards.map((c) => [c.id, c.diff, c.axes]),
    [
      ["c1", "정면 -Y", { W: "X", D: "Y", H: "Z" }],
      ["c2", "정면 +X", { W: "Y", D: "X", H: "Z" }],
    ],
  );
  // 전체 폭 슬라이더 하나: 스윕 범위 300~900과 기본값 600의 형상
  const [preview] = cards[0].previews;
  assert.equal(cards[0].previews.length, 1);
  assert.deepEqual([preview.parameter, preview.values], ["body_w", [300, 600, 900]]);
  const [narrow, middle, wide] = preview.images.map(drawnWidth);
  assert.ok(narrow < middle && middle < wide, `${narrow} < ${middle} < ${wide}`);
});

test("운영자가 고른 후보가 명세 작성의 입력이 되고, 명세의 정면은 그 후보를 따라야 한다", async () => {
  const back = { ...spec, front: "+Y" };
  const { ai, store, ports } = setup({ spec: [spec, back] });
  const { human, shown } = choosing("c2");

  const result = await runPipeline({ bundle, intake, human, ports });

  assert.equal(result.status, "submitted");
  const [first, second] = ai.calls.spec as { candidate: Candidate; schemaErrors: string[] }[];
  assert.deepEqual(first.candidate, { ...candidates[1], axes: { W: "X", D: "Y", H: "Z" }, sliders: [{ parameter: "body_w", name: "전체 폭", parent: "body_w" }] });
  assert.deepEqual(second.schemaErrors, ["/front: 고른 후보의 정면 +Y이어야 합니다(지금 -Y)"]);
  assert.equal((await store.cases.list())[0].chosen.id, "c2");
  // 부모 파라미터인 슬라이더에도 같이 변하는 다른 치수가 적힌다(자기 치수 "전체 폭"은 빼고)
  assert.deepEqual(shown[0][1].choices, [{ parameter: "body_w", name: "전체 폭", options: [{ parent: "body_w", alsoChanges: ["몸통 폭", "서랍 폭"] }] }]);
});

test("정보 입력의 상품 종류가 정해진 목록 밖이거나 상품명이 비었으면 후보 제시 전에 멈춘다", async () => {
  const { ai, store, ports } = setup();

  const result = await runPipeline({ bundle, intake: { ...intake, name: "", kind: "가구" as Intake["kind"] }, human: approveFirst, ports });

  assert.equal(result.status, "stopped");
  assert.equal(result.status === "stopped" && result.stage, "intake");
  assert.match(result.status === "stopped" ? result.reason : "", /\/kind: .*서랍장/);
  assert.match(result.status === "stopped" ? result.reason : "", /\/name/);
  assert.equal(ai.calls.parts.length + ai.calls.candidates.length, 0);
  assert.ok(!store.log.some((e) => e.stage === "candidates"));
});

test("명세가 JSON Schema 검사를 통과하지 못하면 이유를 붙여 다시 묻고, 고친 명세로 조립한다", async () => {
  const broken = { ...spec, sliders: [{ ...spec.sliders[0], unit: "cm" }] };
  const { ai, store, ports } = setup({ spec: [broken, spec] });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const asked = ai.calls.spec as { schemaErrors: string[] }[];
  assert.deepEqual(asked[0].schemaErrors, []);
  assert.match(asked[1].schemaErrors.join(), /\/sliders\/0\/unit/);
  assert.deepEqual(JSON.parse(store.submissions[0].files["spec.json"]), spec);
});

test("정해진 값 목록 밖의 값이면 형식 오류에 고를 수 있는 값을 적는다", async () => {
  const wrongAxes = { ...spec, axes: { ...spec.axes, W: "W" } };
  const { ai, ports } = setup({ spec: [wrongAxes, spec] });

  await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.deepEqual((ai.calls.spec[1] as { schemaErrors: string[] }).schemaErrors, ["/axes/W: must be equal to one of the allowed values (X, Y, Z)"]);
});

test("깊이 축이 정면 방향의 축이 아니거나 W·D·H가 같은 축을 가리키면 다시 묻는다", async () => {
  const sideways = { ...spec, front: "+X" };
  const shared = { ...spec, axes: { W: "X", D: "Y", H: "X" } };
  const { ai, ports } = setup({ spec: [sideways, shared, spec] });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const [, second, third] = ai.calls.spec as { schemaErrors: string[] }[];
  assert.deepEqual(second.schemaErrors, ["/front: 고른 후보의 정면 -Y이어야 합니다(지금 +X)", "/axes/D: 정면 +X 쪽에서 보면 깊이는 X축입니다(지금 Y)"]);
  assert.deepEqual(third.schemaErrors, ["/axes: W·D·H는 서로 다른 축이어야 합니다(W X, D Y, H X)"]);
});

test("명세가 끝내 JSON Schema 검사를 통과하지 못하면 조립하지 않고 멈춘다", async () => {
  const broken = { ...spec, front: "앞" };
  const { store, ports } = setup({ spec: [broken, broken, broken, broken] });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "stopped");
  assert.equal(result.status === "stopped" && result.stage, "spec");
  assert.ok(!store.log.some((e) => e.stage === "assembly"));
  assert.equal(store.submissions.length, 0);
});

test("명세의 상품명이 정보 입력의 상품명과 다르면 다시 묻는다", async () => {
  const renamed = { ...spec, product: "다른 상품" };
  const { ai, ports } = setup({ spec: [renamed, spec] });

  await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.match((ai.calls.spec[1] as { schemaErrors: string[] }).schemaErrors.join(), /\/product/);
});

test("슬라이더의 source가 그 상품 종류의 치수 규칙에 없으면 이유를 붙여 다시 묻는다", async () => {
  const unknown = { ...spec, sliders: [{ ...spec.sliders[0], source: "치수규칙/선반/폭" }] };
  const { ai, ports } = setup({ spec: [unknown, spec] });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  assert.deepEqual((ai.calls.spec[1] as { schemaErrors: string[] }).schemaErrors, [
    "/sliders/0/source: 서랍장의 치수 규칙에 없는 이름(치수규칙/선반/폭)입니다",
  ]);
  // 명세 작성은 그 상품 종류의 치수 규칙만 받는다
  assert.deepEqual((ai.calls.spec[0] as { rules: DimensionRule[] }).rules, rules.filter((r) => r.kind === "서랍장"));
});

test("슬라이더 범위가 정보 입력 메모나 스윕 범위를 벗어나면 세 범위의 교집합을 붙여 다시 묻는다", async () => {
  // 메모는 폭 400~900, 스윕 범위는 300~900, 치수 규칙은 300~1200이다
  const outside = { ...spec, sliders: [{ ...spec.sliders[0], min: 350, max: 950 }] };
  const { ai, ports } = setup({ spec: [outside, spec] });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const why = "치수 규칙 치수규칙/서랍장/폭 300~1200, 정보 입력 메모 폭 400~900, 스윕 범위 300~900";
  assert.deepEqual((ai.calls.spec[1] as { schemaErrors: string[] }).schemaErrors, [
    `/sliders/0/min: 범위 교집합 400~900 밖의 값(350)입니다(${why})`,
    `/sliders/0/max: 범위 교집합 400~900 밖의 값(950)입니다(${why})`,
  ]);
});

test("메모의 범위는 조사·쌍점·쉼표·단위가 붙어도 읽고, 읽지 못한 범위는 정보 입력 처리 기록에 남긴다", async () => {
  const outside = { ...spec, sliders: [{ ...spec.sliders[0], max: 850 }] };
  const { ai, store, ports } = setup({ spec: [outside, spec] });

  await runPipeline({ bundle, intake: { ...intake, memo: "폭은 40～80cm, 받침 100~200" }, human: approveFirst, ports });

  assert.match((ai.calls.spec[1] as { schemaErrors: string[] }).schemaErrors.join(), /정보 입력 메모 폭 400~800/);
  const unread = store.log.filter((e) => e.stage === "intake").map((e) => e.detail);
  assert.deepEqual(unread.slice(1), [{ memoUnread: ["100~200"] }]);

  const commas = setup({ spec: [{ ...spec, sliders: [{ ...spec.sliders[0], min: 300 }] }, spec] });
  await runPipeline({ bundle, intake: { ...intake, memo: "폭: 400mm ~ 1,200mm" }, human: approveFirst, ports: commas.ports });
  assert.match((commas.ai.calls.spec[1] as { schemaErrors: string[] }).schemaErrors.join(), /정보 입력 메모 폭 400~1200/);
});

test("source의 치수 규칙이 슬라이더와 다른 축의 부위면 이유를 붙여 다시 묻는다", async () => {
  const otherAxis = { ...spec, sliders: [{ ...spec.sliders[0], source: "치수규칙/서랍장/높이" }] };
  const { ai, ports } = setup({ spec: [otherAxis, spec] });

  await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.deepEqual((ai.calls.spec[1] as { schemaErrors: string[] }).schemaErrors, [
    "/sliders/0/source: 치수규칙/서랍장/높이의 축(H)이 슬라이더 축(W)과 다릅니다",
  ]);
});

test("메모의 범위는 긴 부위 이름부터 읽어 서랍 깊이의 범위가 깊이로 잡히지 않는다", async () => {
  const { ai, ports } = setup({ spec: [depthSpec, spec] });

  await runPipeline({ bundle, intake: { ...intake, memo: "깊이 300~600, 서랍 깊이 300~500" }, human: approveFirst, ports });

  assert.deepEqual((ai.calls.spec[1] as { schemaErrors: string[] }).schemaErrors, [
    "/sliders/1/max: 범위 교집합 300~500 밖의 값(600)입니다(치수 규칙 치수규칙/서랍장/서랍_깊이 200~650, 정보 입력 메모 서랍 깊이 300~500, 스윕 범위 215~645)",
  ]);
});

test("메모에 범위가 없는 부위는 치수 규칙과 스윕 범위의 교집합만 본다", async () => {
  const narrow = rules.map((r) => (r.id === "치수규칙/서랍장/폭" ? { ...r, min: 450, max: 850 } : r));
  const fitted = { ...spec, sliders: [{ ...spec.sliders[0], min: 450 }] };
  const { ai, ports } = setup({ spec: [spec, fitted] }, offline, narrow);

  const result = await runPipeline({ bundle, intake: { ...intake, memo: "높이는 고정" }, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  assert.deepEqual((ai.calls.spec[1] as { schemaErrors: string[] }).schemaErrors, [
    "/sliders/0/min: 범위 교집합 450~850 밖의 값(400)입니다(치수 규칙 치수규칙/서랍장/폭 450~850, 스윕 범위 300~900)",
  ]);
});

test("치수 규칙·메모·스윕 범위의 교집합이 비면 조립하지 않고 범위 교집합 없음을 처리 기록과 명세 작성에 알린다", async () => {
  // 메모의 폭 1000~1200은 스윕 범위 300~900과 겹치지 않는다. 다시 쓴 명세는 폭 슬라이더를 빼고 높이만 둔다.
  const heightOnly: Spec = { ...spec, sliders: [widthHeightSpec.sliders[1]] };
  const { ai, store, ports } = setup({ spec: [spec, heightOnly] });

  const result = await runPipeline({ bundle, intake: { ...intake, memo: "폭 1000~1200" }, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const expected: Feedback = {
    path: "sliders[0].source",
    slider: "body_w",
    part: "",
    kind: "no_range_intersection",
    measured: { rule: { id: "치수규칙/서랍장/폭", min: 300, max: 1200 }, memo: { min: 1000, max: 1200 }, sweep: { min: 300, max: 900 }, default: 600 },
    expected: "세 범위가 겹치고 기본값을 담는 구간",
    hint:
      "body_w의 세 범위(치수 규칙 치수규칙/서랍장/폭 300~1200, 정보 입력 메모 폭 1000~1200, 스윕 범위 300~900)가 겹치지 않습니다. " +
      "범위를 지어내거나 다른 부위의 치수 규칙으로 바꾸지 말고 이 슬라이더를 빼세요. 운영자는 정보 입력 메모와 모델을 확인해야 합니다",
  };
  assert.deepEqual((ai.calls.spec[1] as { feedback: Feedback[] }).feedback, [expected]);
  assert.deepEqual(verificationLog(store)[0], { attempt: 0, feedback: [expected] });
  // 교집합이 빈 명세는 조립하지 않는다
  assert.deepEqual(store.log.map((e) => e.stage).filter((s) => s === "assembly" || s === "verification"), ["verification", "assembly", "verification"]);
});

test("교집합이 업로드한 모델의 값(기본값)을 담지 않아도 범위 교집합 없음으로 알린다", async () => {
  const heightOnly: Spec = { ...spec, sliders: [widthHeightSpec.sliders[1]] };
  const { ai, ports } = setup({ spec: [spec, heightOnly] });

  await runPipeline({ bundle, intake: { ...intake, memo: "폭 700~900" }, human: approveFirst, ports });

  const [feedback] = (ai.calls.spec[1] as { feedback: Feedback[] }).feedback;
  assert.equal(feedback.kind, "no_range_intersection");
  assert.equal(
    feedback.hint,
    "body_w의 세 범위(치수 규칙 치수규칙/서랍장/폭 300~1200, 정보 입력 메모 폭 700~900, 스윕 범위 300~900)가 겹치는 700~900에 업로드한 모델의 값(600)이 없습니다. " +
      "범위를 지어내거나 다른 부위의 치수 규칙으로 바꾸지 말고 이 슬라이더를 빼세요. 운영자는 정보 입력 메모와 모델을 확인해야 합니다",
  );
});

test("슬라이더 기본값이 업로드한 모델의 값이 아니거나 범위 밖이면 이유를 붙여 다시 묻는다", async () => {
  const otherDefault = { ...spec, sliders: [{ ...spec.sliders[0], default: 650 }] };
  const aboveDefault = { ...spec, sliders: [{ ...spec.sliders[0], min: 650 }] };
  const { ai, ports } = setup({ spec: [otherDefault, aboveDefault, spec] });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const errors = (ai.calls.spec as { schemaErrors: string[] }[]).slice(1).map((call) => call.schemaErrors);
  assert.deepEqual(errors, [
    ["/sliders/0/default: 업로드한 모델의 값(600)과 다릅니다"],
    ["/sliders/0/default: 범위(650~800) 밖의 값(600)입니다"],
  ]);
});

test("처리 기록의 단계 전이마다 어느 상품인지 남는다", async () => {
  const { store, ports } = setup();

  await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.ok(store.log.every((e) => e.product === "1단 서랍장"));
});

/** body_w=825 검증점에서 Fusion 서랍이 보간보다 0.3 mm 넓은 녹화본. 범위가 825를 넘는 명세만 수치 검증에 걸린다. */
const nonlinearAt825 = () => pushMaxSide(825, "DrawerBox", "X", 0.3);

/** 수치 검증에 걸리는 명세: body_w 범위를 스윕 끝(900)까지 넓혔다 */
const tooWide: Spec = { ...spec, sliders: [{ ...spec.sliders[0], max: 900 }] };

test("수치 검증에 실패하면 검증 피드백을 붙여 명세 작성을 다시 하고, 고친 명세로 제출한다", async () => {
  const { ai, store, ports } = setup({ spec: [tooWide, spec] });

  const result = await runPipeline({ bundle: nonlinearAt825(), intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const asked = ai.calls.spec as { feedback: Feedback[] }[];
  assert.deepEqual(asked[0].feedback, []);
  const drawer = asked[1].feedback.find((f) => f.part === "DrawerBox" && f.kind === "dimension_error");
  assert.ok(drawer, JSON.stringify(asked[1].feedback));
  assert.equal(drawer.path, "sliders[0].max");
  assert.match(drawer.hint, /825/);
  assert.deepEqual(JSON.parse(store.submissions[0].files["spec.json"]), spec);
  assert.deepEqual(
    store.log.filter((e) => e.stage === "verification").map((e) => (e.detail as { feedback: Feedback[] }).feedback.length > 0),
    [true, false],
  );
});

test("같은 후보로 3번 넘게 수치 검증에 실패하면 실패 이유를 붙여 후보 제시로 돌아간다", async () => {
  const { ai, store, ports } = setup({
    candidates: [candidates, candidates],
    style: [{ style: "natural" }, { style: "natural" }],
    spec: [tooWide, tooWide, tooWide, tooWide, spec],
  });

  const result = await runPipeline({ bundle: nonlinearAt825(), intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  // 처음 명세 + 피드백 재시도 3번이 모두 실패한 뒤 후보 제시로 돌아갔다
  assert.equal(ai.calls.spec.length, 5);
  const proposals = ai.calls.candidates as { failures: { candidate: Candidate; feedback: Feedback[] }[] }[];
  assert.deepEqual(proposals[0].failures, []);
  assert.equal(proposals[1].failures.length, 1);
  assert.deepEqual(proposals[1].failures[0].candidate, { ...candidates[0], axes: { W: "X", D: "Y", H: "Z" }, sliders: [{ parameter: "body_w", name: "전체 폭", parent: "body_w" }] });
  assert.ok(proposals[1].failures[0].feedback.some((f) => f.kind === "dimension_error" && f.part === "DrawerBox"));
  assert.deepEqual(
    store.log.map((e) => e.stage).filter((s) => s === "candidates" || s === "verification"),
    ["candidates", "verification", "verification", "verification", "verification", "candidates", "verification"],
  );
});

/** 축 반응이 틀린 명세: 전체 깊이가 서랍 깊이도 바꾸는데 형태 변경 부품에 서랍을 빠뜨렸다 */
const drawerMissing = (base: Spec): Spec => ({
  ...base,
  sliders: base.sliders.map((s) => (s.id === "body_d" || s.id === "body_w" ? { ...s, affects: { shape: ["Carcass"], move: [] } } : s)),
});

const depthIntake = { ...intake, memo: "전체 깊이와 서랍 깊이" };

test("한 축에 슬라이더가 둘인 명세에서 축 반응이 틀리면 부품과 명세 위치를 담은 피드백으로 다시 쓴다", async () => {
  // 축 반응을 고친 명세는 교차 검증에 걸리고(서랍 깊이가 전체 깊이의 자식), 세 번째 명세는 전체 폭 하나로 줄였다.
  const { ai, store, ports } = setup({ spec: [drawerMissing(depthSpec), depthSpec, spec] }, recordedFusion(crossDepth).port);

  const result = await runPipeline({ bundle, intake: depthIntake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const asked = ai.calls.spec as { feedback: Feedback[] }[];
  assert.deepEqual(
    asked[1].feedback.map(({ path, slider, part, kind }) => ({ path, slider, part, kind })),
    [{ path: "sliders[0].affects.shape", slider: "body_d", part: "DrawerBox", kind: "unexpected_shape_change" }],
  );
  assert.deepEqual(JSON.parse(store.submissions[0].files["spec.json"]), spec);
});

test("축 반응은 수치 검증을 통과한 명세에만 검사한다", async () => {
  // 처음 명세는 수치 검증과 축 반응이 모두 틀렸다. 수치 피드백만 돌아간다.
  const { ai, ports } = setup({ spec: [drawerMissing(tooWide), drawerMissing(spec), spec] });

  const result = await runPipeline({ bundle: nonlinearAt825(), intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const kinds = (ai.calls.spec as { feedback: Feedback[] }[]).map((call) => [...new Set(call.feedback.map((f) => f.kind))]);
  assert.deepEqual(kinds, [[], ["dimension_error"], ["unexpected_shape_change"]]);
});

test("명세가 녹화본에 없는 슬라이더·부품 이름을 쓰거나 한 부품을 형태 변경과 위치 이동에 함께 두면 이유를 붙여 다시 묻는다", async () => {
  const wrongNames: Spec = {
    ...depthSpec,
    sliders: [
      { ...depthSpec.sliders[0], affects: { shape: ["Carcass", "Drawer"], move: ["Carcass"] } },
      { ...depthSpec.sliders[1], id: "drawer_depth" },
    ],
  };
  const { ai, ports } = setup({ spec: [wrongNames, depthSpec, spec] }, recordedFusion(crossDepth).port);

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const errors = (ai.calls.spec[1] as { schemaErrors: string[] }).schemaErrors;
  assert.equal(errors.length, 4, errors.join("\n"));
  assert.match(errors.join("\n"), /\/sliders\/0\/affects\/shape.*Drawer/);
  assert.match(errors.join("\n"), /\/sliders\/0\/affects.*Carcass/);
  assert.match(errors.join("\n"), /\/sliders\/1\/id: drawer_depth는 스윕한/);
  // 고른 후보의 슬라이더도 아니다
  assert.match(errors.join("\n"), /\/sliders\/1\/id: 고른 후보의 부모 파라미터/);
});

const corners = [
  { body_w: 400, body_h: 500 },
  { body_w: 400, body_h: 1000 },
  { body_w: 800, body_h: 500 },
  { body_w: 800, body_h: 1000 },
];

const verificationLog = (store: ReturnType<typeof setup>["store"]) => store.log.filter((e) => e.stage === "verification").map((e) => e.detail);

test("슬라이더가 둘이면 그 쌍의 모서리 조합 교차 검증 샘플을 요청하고, 덧셈이 맞으면 제출한다", async () => {
  const fusion = recordedFusion();
  const { store, ports } = setup({ spec: [widthHeightSpec] }, fusion.port);

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  assert.deepEqual(fusion.requests, [{ kind: "cross", values: corners }]);
  assert.deepEqual(JSON.parse(store.submissions[0].files["spec.json"]), widthHeightSpec);
});

test("서랍 깊이가 수식으로 전체 깊이를 따르는 쌍은 덧셈이 맞지 않아 교차 검증 피드백이 나온다", async () => {
  const fusion = recordedFusion(crossDepth);
  const { ai, ports } = setup({ spec: [depthSpec, spec] }, fusion.port);

  const result = await runPipeline({ bundle, intake: depthIntake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const feedback = (ai.calls.spec[1] as { feedback: Feedback[] }).feedback;
  const drawer = feedback.find((f) => f.part === "DrawerBox" && f.kind === "dimension_error" && (f.measured as { dimension: string }).dimension === "D");
  assert.ok(drawer, JSON.stringify(feedback));
  assert.equal(drawer.path, "sliders[0]");
  assert.equal(drawer.slider, "body_d");
  // 두 슬라이더가 모두 서랍 깊이를 바꾸므로 큰 쪽 모서리에서 서랍 깊이가 두 번 더해진다
  const worst = feedback.filter((f) => f.part === "DrawerBox" && f.kind === "dimension_error");
  assert.ok(worst.some((f) => JSON.stringify((f.measured as { values: object }).values) === JSON.stringify({ body_d: 600, drawer_d: 600 })));
  assert.match(drawer.hint, /자식/);
});

/** 몸통 윗면이 3 mm 높은 (800, 1000) 모서리 샘플. 덧셈은 이 모서리에서만 틀린다. */
function raisedCorner(): CrossSample[] {
  const samples = structuredClone(crossCorners);
  const corner = samples.find((s) => s.values.body_w === 800 && s.values.body_h === 1000)!;
  for (const face of corner.faces) {
    if (face.body !== "Carcass") continue;
    for (const p of face.points) if (Math.abs(p[2] - 1000) < 1e-6) p[2] += 3;
  }
  return samples;
}

test("교차 검증 샘플에서 덧셈 오차가 합격선을 넘으면 그 쌍을 가리키는 피드백으로 명세를 다시 쓴다", async () => {
  const fusion = recordedFusion(raisedCorner());
  const { ai, store, ports } = setup({ spec: [widthHeightSpec, spec] }, fusion.port);

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const feedback = (ai.calls.spec[1] as { feedback: Feedback[] }).feedback;
  assert.ok(feedback.length > 0);
  for (const f of feedback) {
    assert.equal(f.slider, "body_w");
    assert.equal(f.part, "Carcass");
    assert.deepEqual((f.measured as { values: object }).values, { body_w: 800, body_h: 1000 });
    assert.match(f.hint, /body_w.*body_h/);
  }
  assert.deepEqual([...new Set(feedback.map((f) => f.kind))].sort(), ["dimension_error", "shape_error"]);
  assert.ok(feedback.some((f) => (f.measured as { dimension?: string }).dimension === "H"));
  // 다시 쓴 명세는 슬라이더가 하나라 교차 검증 샘플을 요청하지 않는다
  assert.equal(fusion.requests.length, 1);
  assert.deepEqual(JSON.parse(store.submissions[0].files["spec.json"]), spec);
});

test("애드인 연결이 끊기면 실패로 기록하지 않고 Fusion 연결 필요로 기다렸다가, 다시 연결되면 이어서 검증한다", async () => {
  const fusion = recordedFusion();
  let connected = false;
  let reconnect = () => {};
  // 실행기가 연결을 기다리기 시작하면 풀린다
  let markWaiting = () => {};
  const waiting = new Promise<void>((resolve) => (markWaiting = resolve));
  const flaky: FusionPort = {
    requestSamples: (request) => (connected ? fusion.port.requestSamples(request) : Promise.resolve({ status: "disconnected" })),
    reconnected: () =>
      new Promise<void>((resolve) => {
        reconnect = () => {
          connected = true;
          resolve();
        };
        markWaiting();
      }),
  };
  const { ai, store, ports } = setup({ spec: [widthHeightSpec] }, flaky);

  const running = runPipeline({ bundle, intake, human: approveFirst, ports });
  await waiting;

  // 검증이 멈춰 있고, 처리 기록에 Fusion 연결 필요가 보인다
  assert.deepEqual(verificationLog(store), [{ fusion: "Fusion 연결 필요" }]);
  assert.equal(store.submissions.length, 0);
  reconnect();
  const result = await running;

  assert.equal(result.status, "submitted");
  assert.equal(ai.calls.spec.length, 1);
  assert.deepEqual(fusion.requests, [{ kind: "cross", values: corners }]);
  assert.deepEqual(verificationLog(store), [{ fusion: FUSION_NEEDED }, { fusion: FUSION_RECONNECTED }, { attempt: 0, feedback: [] }]);
});

test("애드인 응답이 업로드 묶음의 샘플 형식이 아니면 검증 단계에서 멈춘다", async () => {
  const broken: FusionPort = {
    requestSamples: async (request) => ({ status: "answered", response: { samples: request.values.map((values) => ({ values })) } }),
    reconnected: () => Promise.resolve(),
  };
  const { store, ports } = setup({ spec: [widthHeightSpec] }, broken);

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "stopped");
  assert.equal(result.status === "stopped" && result.stage, "verification");
  assert.match(result.status === "stopped" ? result.reason : "", /samples\/0/);
  assert.equal(store.submissions.length, 0);
});

test("애드인이 추가 샘플을 뽑지 못했다고 알리면 그 이유로 검증 단계에서 멈춘다", async () => {
  const failing: FusionPort = {
    requestSamples: async () => ({ status: "failed", reason: "ValueError: 모델에 없는 파라미터: body_h" }),
    reconnected: () => Promise.resolve(),
  };
  const { store, ports } = setup({ spec: [widthHeightSpec] }, failing);

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "stopped");
  assert.equal(result.status === "stopped" && result.stage, "verification");
  assert.match(result.status === "stopped" ? result.reason : "", /모델에 없는 파라미터: body_h/);
  assert.equal(store.submissions.length, 0);
});

/** 전체 깊이·서랍 깊이 쌍의 녹화본: 교차 검증 모서리, 3×3 격자, 격자 칸 가운데 */
const depthRecordings = () => [...crossDepth, ...gridDepth, ...gridDepthChecks];

const depthGridValues = [
  ...[300, 450, 600].flatMap((body_d) => [300, 430, 600].map((drawer_d) => ({ body_d, drawer_d }))),
  ...[375, 525].flatMap((body_d) => [365, 515].map((drawer_d) => ({ body_d, drawer_d }))),
  { body_d: 375, drawer_d: 430 },
  { body_d: 525, drawer_d: 430 },
  { body_d: 450, drawer_d: 365 },
  { body_d: 450, drawer_d: 515 },
];

test("명세를 고쳐 다시 써도 교차 검증에 실패한 쌍은 3×3 격자 샘플로 보강하고, 격자 보간으로 통과하면 제출한다", async () => {
  // AI가 피드백을 받고도 같은 쌍을 다시 냈다
  const fusion = recordedFusion(depthRecordings());
  const { ai, store, ports } = setup({ spec: [depthSpec, depthSpec] }, fusion.port);

  const result = await runPipeline({ bundle, intake: depthIntake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  // 처음 실패에는 격자를 요청하지 않고 피드백으로 명세를 다시 쓴다
  assert.equal(ai.calls.spec.length, 2);
  assert.ok((ai.calls.spec[1] as { feedback: Feedback[] }).feedback.length > 0);
  // 격자 9곳 다음에 검증점(격자 칸 가운데 4곳, 기본값 줄 위 마디 사이 4곳)을 요청한다. 같은 교차 검증 요청은 다시 보내지 않는다.
  assert.deepEqual(
    fusion.requests.map((r) => r.kind),
    ["cross", "grid"],
  );
  assert.deepEqual(fusion.requests[1].values, depthGridValues);
  // 격자 보강 쌍은 명세가 아니라 결과물의 스윕 데이터에 담긴다
  const files = store.submissions[0].files;
  assert.deepEqual(JSON.parse(files["spec.json"]), depthSpec);
  const grids = JSON.parse(files["sweeps.json"]).grids as { parameters: string[]; samples: { values: object }[] }[];
  assert.deepEqual(grids.map((g) => g.parameters), [["body_d", "drawer_d"]]);
  assert.deepEqual(grids[0].samples.map((s) => s.values), depthGridValues.slice(0, 9));
  assert.ok(verificationLog(store).some((d) => JSON.stringify(d) === JSON.stringify({ grid: ["body_d", "drawer_d"] })));
});

test("격자 보강해도 격자 검증점에서 합격선을 넘으면 격자 보간이 맞지 않는다는 피드백으로 명세를 다시 쓴다", async () => {
  // 격자 칸 가운데 하나에서 서랍이 3 mm 더 깊다
  const recordings = depthRecordings();
  const bent = recordings.find((s) => s.values.body_d === 525 && s.values.drawer_d === 515 && gridDepthChecks.includes(s))!;
  const shifted = structuredClone(bent);
  for (const f of shifted.faces) if (f.body === "DrawerBox") for (const p of f.points) if (Math.abs(p[1] - 515) < 1e-6) p[1] += 3;
  const fusion = recordedFusion(recordings.map((s) => (s === bent ? shifted : s)));
  const { ai, store, ports } = setup({ spec: [depthSpec, depthSpec, spec] }, fusion.port);

  const result = await runPipeline({ bundle, intake: depthIntake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const feedback = (ai.calls.spec[2] as { feedback: Feedback[] }).feedback;
  assert.ok(feedback.length > 0);
  for (const f of feedback) {
    assert.equal(f.slider, "body_d");
    assert.equal(f.part, "DrawerBox");
    assert.deepEqual((f.measured as { values: object }).values, { body_d: 525, drawer_d: 515 });
    assert.match(f.hint, /격자/);
  }
  assert.deepEqual(JSON.parse(store.submissions[0].files["spec.json"]), spec);
});

test("격자 보강이 필요한 쌍이 2쌍을 넘으면 격자를 요청하지 않고 검증 피드백으로 명세를 다시 쓴다", async () => {
  // 모든 교차 검증 샘플에서 몸통 윗면이 3 mm 높아 세 쌍이 모두 덧셈에 실패한다
  const raised = structuredClone(crossThree);
  for (const sample of raised) {
    const carcass = sample.faces.filter((f) => f.body === "Carcass");
    const top = Math.max(...carcass.flatMap((f) => f.points.map((p) => p[2])));
    for (const f of carcass) for (const p of f.points) if (Math.abs(p[2] - top) < 1e-6) p[2] += 3;
  }
  const fusion = recordedFusion(raised);
  const { ai, store, ports } = setup({ spec: [threeSpec, threeSpec, spec] }, fusion.port);

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  assert.deepEqual(fusion.requests.map((r) => r.kind), ["cross"]);
  const feedback = (ai.calls.spec[2] as { feedback: Feedback[] }).feedback;
  const limit = feedback.filter((f) => f.kind === "grid_limit");
  assert.equal(limit.length, 1, JSON.stringify(feedback));
  assert.deepEqual(limit[0].measured, { pairs: [["body_w", "body_h"], ["body_w", "body_d"], ["body_h", "body_d"]] });
  assert.deepEqual(limit[0].expected, { max_pairs: 2 });
  assert.match(limit[0].hint, /2쌍/);
  // 덧셈이 틀린 쌍의 교차 검증 피드백도 함께 간다
  assert.ok(feedback.some((f) => f.kind === "shape_error"));
  assert.deepEqual(JSON.parse(store.submissions[0].files["spec.json"]), spec);
});

test("격자 샘플 하나라도 재계산에 실패하면 그 쌍은 보강하지 않고 재계산 실패 피드백으로 명세를 다시 쓴다", async () => {
  const recordings = depthRecordings().map((s) =>
    gridDepth.includes(s) && s.values.body_d === 450 && s.values.drawer_d === 600 ? { ...s, status: "recompute_failed" as const, faces: [] } : s,
  );
  const fusion = recordedFusion(recordings);
  const { ai, store, ports } = setup({ spec: [depthSpec, depthSpec, spec] }, fusion.port);

  const result = await runPipeline({ bundle, intake: depthIntake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const feedback = (ai.calls.spec[2] as { feedback: Feedback[] }).feedback;
  const failed = feedback.filter((f) => f.kind === "recompute_failed");
  assert.equal(failed.length, 1, JSON.stringify(feedback));
  assert.deepEqual(failed[0].measured, { values: { body_d: 450, drawer_d: 600 } });
  assert.match(failed[0].hint, /격자 보강 샘플/);
  assert.ok(!verificationLog(store).some((d) => JSON.stringify(d).includes('"grid"')));
  assert.equal(JSON.parse(store.submissions[0].files["sweeps.json"]).grids, undefined);
});

/** 전체 깊이 하나로 된 명세. 범위 300~600은 속 비우기 면 지정점 녹화본에서 줄어든 스윕 범위(337.5~675)를 min 쪽에서 넘는다. */
const bodyDepthSpec: Spec = { ...spec, sliders: [depthSpec.sliders[0]] };
const depthCandidates: Candidate[] = candidates.map((c) => ({ ...c, sliders: [{ parameter: "body_d", name: "전체 깊이" }] }));

test("업로드 묶음에 모델링 오류 의심으로 줄어든 범위가 있으면 업로드 단계 처리 기록으로 운영자에게 알린다", async () => {
  const { store, ports } = setup({ candidates: [depthCandidates], spec: [{ ...bodyDepthSpec, sliders: [{ ...bodyDepthSpec.sliders[0], min: 337.5 }] }] });

  const result = await runPipeline({ bundle: shellPointRecording, intake: depthIntake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const upload = store.log.find((e) => e.stage === "upload")!;
  const feedback = (upload.detail as { feedback: Feedback[] }).feedback;
  assert.deepEqual(
    feedback.map((f) => [f.slider, f.kind]),
    [
      ["body_d", "modeling_error_suspected"],
      ["drawer_d", "modeling_error_suspected"],
    ],
  );
  // 범위가 줄지 않은 녹화본은 업로드 기록에 피드백이 없다
  const plain = setup();
  await runPipeline({ bundle, intake, human: approveFirst, ports: plain.ports });
  assert.equal(plain.store.log.find((e) => e.stage === "upload")!.detail, undefined);
});

test("명세 범위가 줄어든 스윕 범위를 넘으면 그 까닭을 담은 피드백으로 다시 쓰고, 좁힌 명세로 제출한다", async () => {
  const narrowed: Spec = { ...bodyDepthSpec, sliders: [{ ...bodyDepthSpec.sliders[0], min: 337.5 }] };
  const { ai, store, ports } = setup({ candidates: [depthCandidates], spec: [bodyDepthSpec, narrowed] });

  const result = await runPipeline({ bundle: shellPointRecording, intake: depthIntake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const [, second] = ai.calls.spec as { feedback: Feedback[] }[];
  assert.deepEqual(
    second.feedback.map(({ path, slider, part, kind, expected }) => ({ path, slider, part, kind, expected })),
    [{ path: "sliders[0].min", slider: "body_d", part: "DrawerBox", kind: "modeling_error_suspected", expected: { min: 337.5 } }],
  );
  assert.deepEqual(JSON.parse(store.submissions[0].files["spec.json"]), narrowed);
});

test("후보가 개수형 파라미터나 스윕한 부모를 따르지 않는 파라미터를 노출하면 이유를 붙여 후보를 다시 묻는다", async () => {
  const withCount = structuredClone(bundle);
  withCount.parameters.push({ name: "shelves", value: 2, unit: "", expression: "2", is_user: true, is_count: true });
  const counted = candidates.map((c, i) => ({ ...c, sliders: [i === 0 ? { parameter: "shelves", name: "선반 수" } : { parameter: "d8", name: "손잡이 높이" }] }));
  const { ai, ports } = setup({ candidates: [counted, candidates] });

  const result = await runPipeline({ bundle: withCount, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const errors = (ai.calls.candidates[1] as { schemaErrors: string[] }).schemaErrors;
  assert.deepEqual(errors, [
    "/0/sliders/0/parameter: shelves는 개수형 파라미터라 슬라이더 후보가 될 수 없습니다",
    "/1/sliders/0/parameter: d8는 스윕한 파라미터가 아니고, 수식으로 따르는 스윕한 부모도 없습니다",
  ]);
});

test("업로드 묶음에 보간 실패가 있으면 업로드 단계 처리 기록으로 운영자에게 알린다", async () => {
  const failed = structuredClone(bundle);
  failed.sweeps.find((s: { parameter: string }) => s.parameter === "body_h").interpolation_failure = { at: 412.5, kind: "shape_error", part: "Carcass", error: 3.2, tolerance: 1 };
  const { store, ports } = setup();

  await runPipeline({ bundle: failed, intake, human: approveFirst, ports });

  const upload = store.log.find((e) => e.stage === "upload")!;
  assert.deepEqual(
    (upload.detail as { feedback: Feedback[] }).feedback.map((f) => [f.slider, f.kind]),
    [["body_h", "shape_error"]],
  );
});

test("17점으로도 합격선을 못 맞춘 보간 실패 파라미터를 후보가 노출하면 이유를 붙여 후보를 다시 묻는다", async () => {
  const failed = structuredClone(bundle);
  failed.sweeps.find((s: { parameter: string }) => s.parameter === "body_h").interpolation_failure = {
    at: 412.5,
    kind: "shape_error",
    part: "Carcass",
    error: 3.2,
    tolerance: 1,
  };
  const exposed = candidates.map((c) => ({ ...c, sliders: [{ parameter: "body_h", name: "전체 높이" }] }));
  const { ai, ports } = setup({ candidates: [exposed, candidates] });

  const result = await runPipeline({ bundle: failed, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const errors = (ai.calls.candidates[1] as { schemaErrors: string[] }).schemaErrors;
  assert.deepEqual(errors, [
    "/0/sliders/0/parameter: body_h는 적응형 스윕을 17점까지 늘려도 보간 오차가 합격선을 넘어(보간 실패) 슬라이더 후보가 될 수 없습니다",
    "/1/sliders/0/parameter: body_h는 적응형 스윕을 17점까지 늘려도 보간 오차가 합격선을 넘어(보간 실패) 슬라이더 후보가 될 수 없습니다",
  ]);
});

test("재계산 실패로 스윕 범위가 기본값 하나로 줄어든 파라미터를 후보가 노출하면 이유를 붙여 후보를 다시 묻는다", async () => {
  // 기본값 바로 양옆 검증점에서 재계산이 실패하면 애드인은 범위를 기본값까지 줄인다. 샘플 하나로는 보간할 수 없다.
  const collapsed = structuredClone(bundle);
  const height = collapsed.sweeps.find((s: { parameter: string }) => s.parameter === "body_h");
  height.samples = height.samples.filter((s: { value: number }) => s.value === 700);
  height.checks = [];
  height.range = { min: 700, max: 700 };
  const exposed = candidates.map((c) => ({ ...c, sliders: [{ parameter: "body_h", name: "전체 높이" }] }));
  const { ai, ports } = setup({ candidates: [exposed, candidates] });

  const result = await runPipeline({ bundle: collapsed, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const errors = (ai.calls.candidates[1] as { schemaErrors: string[] }).schemaErrors;
  assert.equal(errors[0], "/0/sliders/0/parameter: body_h는 재계산에 성공한 스윕 샘플이 2개보다 적어 보간할 수 없으므로 슬라이더 후보가 될 수 없습니다");
});

test("칸막이 수가 바뀌는 선반도 위상 묶음을 넘나드는 슬라이더로 검증을 통과해 제출된다", async () => {
  const shelfIntake: Intake = { name: "칸막이 선반", kind: "선반", memo: "폭 500~1300, 깊이 200~400", thickness: "ai" };
  const shelfCandidates: Candidate[] = [
    { id: "c1", front: "-Y", sliders: [{ parameter: "shelf_w", name: "전체 폭" }, { parameter: "shelf_d", name: "전체 깊이" }], showThickness: false, summary: "폭과 깊이", diff: "정면 -Y" },
    { id: "c2", front: "-Y", sliders: [{ parameter: "shelf_w", name: "전체 폭" }], showThickness: false, summary: "폭 하나", diff: "깊이 고정" },
  ];
  const ai = scriptedAi({ parts: [shelfParts], candidates: [shelfCandidates], style: [{ style: "natural" }], spec: [shelfSpec], judgment: [judged()] });
  const store = memoryStore({ styles, rules });
  const fusion = recordedFusion(shelfCrossCorners);

  const result = await runPipeline({ bundle: shelfRecording, intake: shelfIntake, human: approveFirst, ports: { fusion: fusion.port, ai, store } });

  assert.equal(result.status, "submitted", JSON.stringify(store.log.at(-1)));
  assert.equal(fusion.requests.length, 1);
  const sweeps = JSON.parse(store.submissions[0].files["sweeps.json"]);
  assert.equal(sweeps.sweeps.find((s: { parameter: string }) => s.parameter === "shelf_w").groups.length, 2);
});

const shelfIntake: Intake = { name: "칸막이 선반", kind: "선반", memo: "폭 500~1300, 깊이 200~400", thickness: "ai" };
const shelfCandidates: Candidate[] = [
  { id: "c1", front: "-Y", sliders: [{ parameter: "shelf_w", name: "전체 폭" }, { parameter: "shelf_d", name: "전체 깊이" }], showThickness: true, summary: "폭·깊이와 판재 두께", diff: "두께 선택 노출" },
  { id: "c2", front: "-Y", sliders: [{ parameter: "shelf_w", name: "전체 폭" }, { parameter: "shelf_d", name: "전체 깊이" }], showThickness: false, summary: "폭·깊이", diff: "두께 고정" },
];
/** 칸막이 선반 판재 두께 t(기본 18)의 두께 선택 */
const shelfThickness = { ids: ["t"], name: "판재 두께", default: 18, options: [15, 18, 24] };

/** 칸막이 선반 명세들을 차례로 쓰는 AI로 실행한다. 첫 명세의 재작성 이유(schemaErrors)를 돌려준다. */
async function shelfSchemaErrors(first: Spec, bundle: unknown = shelfRecording) {
  const ai = scriptedAi({ parts: [shelfParts], candidates: [shelfCandidates], style: [{ style: "natural" }], spec: [first, shelfSpec], judgment: [judged()] });
  const store = memoryStore({ styles, rules });
  const result = await runPipeline({ bundle, intake: shelfIntake, human: approveFirst, ports: { fusion: recordedFusion(shelfCrossCorners).port, ai, store } });
  assert.equal(result.status, "submitted", JSON.stringify(store.log.at(-1)));
  return (ai.calls.spec[1] as { schemaErrors: string[] }).schemaErrors;
}

test("두께 후보가 표준 두께 목록에서 기본 두께의 앞뒤 한 칸이 아니면 이유를 붙여 명세를 다시 묻는다", async () => {
  const errors = await shelfSchemaErrors({ ...shelfSpec, thickness: [{ ...shelfThickness, options: [15, 18, 21] }] });

  assert.deepEqual(errors, ["/thickness/0/options: 기본 두께 18의 앞뒤 한 칸(15·18·24)이어야 합니다"]);
});

test("목록 끝의 기본 두께는 두께 후보가 2개다", async () => {
  const thin = structuredClone(shelfRecording);
  thin.parameters.find((p) => p.name === "t")!.value = 3;

  const errors = await shelfSchemaErrors({ ...shelfSpec, thickness: [{ ...shelfThickness, default: 3, options: [3, 6, 9] }] }, thin);

  assert.deepEqual(errors, ["/thickness/0/options: 기본 두께 3의 앞뒤 한 칸(3·6)이어야 합니다"]);
});

test("표준 두께 목록에 없는 기본 두께는 명세를 다시 묻는다", async () => {
  const odd = structuredClone(shelfRecording);
  odd.parameters.find((p) => p.name === "t")!.value = 20;

  const errors = await shelfSchemaErrors({ ...shelfSpec, thickness: [{ ...shelfThickness, default: 20, options: [18, 20, 24] }] }, odd);

  assert.deepEqual(errors, ["/thickness/0/default: 20 mm는 표준 두께 목록(3·6·9·12·15·18·24·30)에 없습니다"]);
});

test("하나의 두께 선택으로 묶인 파라미터의 기본 두께가 다르면 명세를 다시 묻는다", async () => {
  const twoBoards = structuredClone(shelfRecording);
  twoBoards.parameters.push({ name: "t_back", value: 9, unit: "mm", expression: "9 mm", is_user: true, is_count: false } as never);

  const errors = await shelfSchemaErrors({ ...shelfSpec, thickness: [{ ...shelfThickness, ids: ["t", "t_back", "t_none"] }] }, twoBoards);

  assert.deepEqual(errors, [
    "/thickness/0/ids: t_none는 업로드 묶음의 파라미터가 아닙니다",
    "/thickness/0/ids: 묶인 파라미터의 기본 두께가 다릅니다(t=18·t_back=9)",
  ]);
});

test("두께 선택의 기본 두께가 업로드한 모델의 값과 다르면 명세를 다시 묻는다", async () => {
  const errors = await shelfSchemaErrors({ ...shelfSpec, thickness: [{ ...shelfThickness, default: 15, options: [12, 15, 18] }] });

  assert.deepEqual(errors, ["/thickness/0/default: 업로드한 모델의 두께(18 mm)와 다릅니다"]);
});

/** 판재 두께 t가 수식으로 슬라이더를 따르는 칸막이 선반(children에는 수식이 따르는 파라미터만 적을 수 있다) */
function thicknessFollowing(slider: string) {
  const recording = structuredClone(shelfRecording);
  recording.parameters.find((p) => p.name === "t")!.expression = `${slider} * 0.06`;
  return recording;
}

test("고정 두께 파라미터가 슬라이더의 자식에 있으면 명세를 다시 묻는다", async () => {
  const sliders = shelfSpec.sliders.map((s, i) => (i === 1 ? { ...s, children: ["t"] } : s));

  const errors = await shelfSchemaErrors({ ...shelfSpec, sliders, fixed: ["t"] }, thicknessFollowing("shelf_d"));

  assert.deepEqual(errors, ["/fixed/0: t는 슬라이더 shelf_d의 children에 있어 고정할 수 없습니다"]);
});

/** 칸막이 선반 두께 선택 명세를 실행한다. Fusion 연결은 교차 검증 모서리와 두께 후보 형상으로 답한다. */
async function runShelfThickness(specs: Spec[], thicknessSamples: CrossSample[] = shelfThicknessSamples) {
  const ai = scriptedAi({ parts: [shelfParts], candidates: [shelfCandidates], style: [{ style: "natural" }], spec: specs, judgment: [judged()] });
  const store = memoryStore({ styles, rules });
  const fusion = recordedFusion([...shelfCrossCorners, ...shelfThicknessCross, ...thicknessSamples]);
  const result = await runPipeline({ bundle: shelfRecording, intake: shelfIntake, human: approveFirst, ports: { fusion: fusion.port, ai, store } });
  return { ai, store, fusion, result };
}

test("두께 선택이 있으면 애드인에 두께 후보 형상을 요청해 결과물의 스윕 데이터에 담는다", async () => {
  const { store, fusion, result } = await runShelfThickness([shelfThicknessSpec]);

  assert.equal(result.status, "submitted", JSON.stringify(store.log.at(-1)));
  const thickness = fusion.requests.filter((r) => r.kind === "thickness");
  // 기본 묶음과, 전체 폭 범위가 닿는 2칸·4칸 위상 묶음의 기준 값에서 기본 두께가 아닌 후보 15·24
  assert.deepEqual(thickness, [
    {
      kind: "thickness",
      values: [{ t: 15 }, { t: 24 }, { t: 15, shelf_w: 675 }, { t: 24, shelf_w: 675 }, { t: 15, shelf_w: 1200.03662109375 }, { t: 24, shelf_w: 1200.03662109375 }],
    },
  ]);
  const { files } = store.submissions[0];
  assert.equal(JSON.parse(files["sweeps.json"]).thickness.length, 6);
  // 제출된 고정 코어가 고른 두께의 형상을 만든다
  const context = vm.createContext({});
  vm.runInContext(files["configurator.js"], context);
  const morph = vm.runInContext("Configurator", context).createMorph(JSON.parse(files["spec.json"]), JSON.parse(files["sweeps.json"]));
  assert.notDeepEqual(morph.positions({ t: 24 }), morph.positions({ t: 18 }));
});

test("두께 후보 형상을 재계산하지 못하면 두께 선택을 가리키는 피드백으로 명세를 다시 쓴다", async () => {
  const failed = shelfThicknessSamples.map((s) => (s.values.t === 24 && s.values.shelf_w === 675 ? { ...s, status: "recompute_failed" as const, faces: [] } : s));

  const { ai, result } = await runShelfThickness([shelfThicknessSpec, shelfSpec], failed);

  assert.equal(result.status, "submitted");
  const { feedback } = ai.calls.spec[1] as { feedback: Feedback[] };
  assert.deepEqual(
    feedback.map(({ path, slider, part, kind, measured }) => ({ path, slider, part, kind, measured })),
    [{ path: "thickness[0].options", slider: "", part: "", kind: "recompute_failed", measured: { values: { t: 24, shelf_w: 675 } } }],
  );
  assert.match(feedback[0].hint, /t=24·shelf_w=675/);
});

test("두께 후보 형상의 면 구성이 기준 형상과 다르면 위상 변화 피드백이 나온다", async () => {
  const changed = shelfThicknessSamples.map((s) => (s.values.t === 15 && s.values.shelf_w === undefined ? { ...s, faces: s.faces.slice(1) } : s));

  const { ai } = await runShelfThickness([shelfThicknessSpec, shelfSpec], changed);

  const { feedback } = ai.calls.spec[1] as { feedback: Feedback[] };
  assert.deepEqual(
    feedback.map(({ path, kind, measured }) => ({ path, kind, measured })),
    [{ path: "thickness[0].options", kind: "topology_change", measured: { values: { t: 15 } } }],
  );
});

test("두께 선택의 파라미터가 슬라이더의 자식이거나 고정 두께·다른 두께 선택에도 있으면 명세를 다시 묻는다", async () => {
  const twoBoards = thicknessFollowing("shelf_w");
  twoBoards.parameters.push({ name: "t_back", value: 18, unit: "mm", expression: "18 mm", is_user: true, is_count: false } as never);
  const sliders = shelfSpec.sliders.map((s, i) => (i === 0 ? { ...s, children: ["t"] } : s));

  const errors = await shelfSchemaErrors(
    { ...shelfSpec, sliders, thickness: [shelfThickness, { ...shelfThickness, ids: ["t_back", "t"], name: "뒤판 두께" }], fixed: ["t_back"] },
    twoBoards,
  );

  assert.deepEqual(errors, [
    "/fixed/0: t_back는 thickness[1]의 두께 선택에도 있습니다",
    "/thickness/0/ids: t는 슬라이더 shelf_w의 children에 있어 두께 선택에 둘 수 없습니다",
    "/thickness/1/ids: t는 슬라이더 shelf_w의 children에 있어 두께 선택에 둘 수 없습니다",
    "/thickness/1/ids: t는 thickness[0]의 두께 선택에도 있습니다",
  ]);
});

test("슬라이더를 움직이면 판재 두께가 바뀌는 모델은 그 슬라이더와 부품을 가리키는 두께 변화 피드백이 나온다", async () => {
  // 몸통 셸 두께가 body_w × 0.03이라 전체 폭을 움직이면 몸통 판재가 두꺼워지거나 얇아진다
  const depthOnly = { ...spec, sliders: [depthSpec.sliders[0]] };
  const { ai, store, ports } = setup({ spec: [spec, depthOnly] });

  const result = await runPipeline({ bundle: ratioThicknessRecording, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted", JSON.stringify(store.log.at(-1)));
  const { feedback } = ai.calls.spec[1] as { feedback: Feedback[] };
  assert.deepEqual(
    feedback.map(({ path, slider, part, kind }) => ({ path, slider, part, kind })),
    [{ path: "sliders[0]", slider: "body_w", part: "Carcass", kind: "thickness_change" }],
  );
  // 범위 끝 쪽 검증점·샘플에서 가장 크게 바뀐 곳을 알린다: 기본 18 mm에서 전체 폭에 비례해 바뀐다
  const measured = feedback[0].measured as { value: number; baseline_mm: number; fusion_mm: number };
  assert.equal(measured.baseline_mm, 18);
  assert.ok(Math.abs(measured.fusion_mm - measured.value * 0.03) < 0.01, JSON.stringify(measured));
  assert.match(feedback[0].hint, /슬라이더 body_w가 부품 Carcass의 두께를 바꿉니다/);
});

test("두께 후보마다 각 슬라이더의 범위 끝에서 교차 검증 샘플을 받아, 덧셈이 맞으면 제출한다", async () => {
  const { store, fusion, result } = await runShelfThickness([shelfThicknessSpec]);

  assert.equal(result.status, "submitted", JSON.stringify(store.log.at(-1)));
  const cross = fusion.requests.filter((r) => r.kind === "cross");
  assert.equal(cross.length, 1);
  // 슬라이더 쌍의 모서리 4곳 다음에, 두께 후보 15·24마다 전체 폭 500·1300(전체 깊이 기본값)과 전체 깊이 200·400(전체 폭 기본값)
  assert.deepEqual(cross[0].values.slice(4), [
    { shelf_w: 500, shelf_d: 300, t: 15 },
    { shelf_w: 1300, shelf_d: 300, t: 15 },
    { shelf_w: 900, shelf_d: 200, t: 15 },
    { shelf_w: 900, shelf_d: 400, t: 15 },
    { shelf_w: 500, shelf_d: 300, t: 24 },
    { shelf_w: 1300, shelf_d: 300, t: 24 },
    { shelf_w: 900, shelf_d: 200, t: 24 },
    { shelf_w: 900, shelf_d: 400, t: 24 },
  ]);
});

/** 서랍 폭 수식에 두께가 비율로 섞인 서랍장의 몸통 두께 선택 명세 */
const mixedThicknessSpec: Spec = { ...spec, thickness: [{ ids: ["t"], name: "몸통 두께", default: 18, options: [15, 18, 24] }] };

test("두께 후보에서 슬라이더와 덧셈이 맞지 않으면 그 두께 선택과 슬라이더를 가리키는 피드백이 나오고, 다시 실패하면 격자로 보강해 제출한다", async () => {
  const ai = scriptedAi({ parts: [partsFound], candidates: [candidates], style: [{ style: "natural" }], spec: [mixedThicknessSpec, mixedThicknessSpec], judgment: [judged()] });
  const store = memoryStore({ styles, rules });
  const fusion = recordedFusion(mixedThicknessSamples);

  const result = await runPipeline({ bundle: mixedThicknessRecording, intake, human: approveFirst, ports: { fusion: fusion.port, ai, store } });

  assert.equal(result.status, "submitted", JSON.stringify(store.log.at(-1)));
  // 처음 실패는 명세 수정으로 돌려준다
  const { feedback } = ai.calls.spec[1] as { feedback: Feedback[] };
  assert.ok(feedback.length > 0);
  for (const f of feedback) {
    assert.equal(f.path, "thickness[0].options");
    assert.equal(f.slider, "body_w");
    assert.match(f.hint, /두께 t와 body_w를 함께 움직이면 덧셈이 맞지 않습니다/);
  }
  assert.ok(feedback.some((f) => f.part === "DrawerBox" && f.kind === "dimension_error"), JSON.stringify(feedback));
  // 다시 쓴 명세에서도 실패해 두께 후보 15·24 × 전체 폭 400·600·800 격자와 마디 사이 검증점을 받았다
  const grid = fusion.requests.filter((r) => r.kind === "grid");
  assert.deepEqual(grid, [
    {
      kind: "grid",
      values: [
        { body_w: 400, t: 15 },
        { body_w: 600, t: 15 },
        { body_w: 800, t: 15 },
        { body_w: 400, t: 24 },
        { body_w: 600, t: 24 },
        { body_w: 800, t: 24 },
        { body_w: 500, t: 15 },
        { body_w: 700, t: 15 },
        { body_w: 500, t: 24 },
        { body_w: 700, t: 24 },
      ],
    },
  ]);
  const sweeps = JSON.parse(store.submissions[0].files["sweeps.json"]);
  assert.deepEqual(sweeps.grids.map((g: { parameters: string[] }) => g.parameters), [["t", "body_w"]]);
  assert.deepEqual(JSON.parse(store.submissions[0].files["spec.json"]), mixedThicknessSpec);
});

/** 섞인 두께 서랍장을 명세들로 실행한다. change로 추가 샘플 하나를 바꿀 수 있다. */
async function runMixedThickness(specs: Spec[], change: (sample: CrossSample) => void = () => {}) {
  const samples = structuredClone(mixedThicknessSamples);
  samples.forEach(change);
  const ai = scriptedAi({ parts: [partsFound], candidates: [candidates], style: [{ style: "natural" }], spec: specs, judgment: [judged()] });
  const store = memoryStore({ styles, rules });
  const result = await runPipeline({ bundle: mixedThicknessRecording, intake, human: approveFirst, ports: { fusion: recordedFusion(samples).port, ai, store } });
  assert.equal(result.status, "submitted", JSON.stringify(store.log.at(-1)));
  return ai.calls.spec.map((call) => (call as { feedback: Feedback[] }).feedback);
}

const at = (values: Record<string, number>) => (s: CrossSample) => JSON.stringify(s.values) === JSON.stringify(values);

test("두께 후보에서 슬라이더가 판 두께를 바꾸면 그 두께 선택과 슬라이더를 가리키는 두께 변화 피드백이 나온다", async () => {
  // t=24·전체 폭 800의 Fusion 형상에서 몸통 오른쪽 바깥 면만 2 mm 밀었다: 몸통 오른쪽 판이 2 mm 두꺼워졌다
  const names = new Set(mixedThicknessRecording.parts.find((p) => p.name === "Carcass")!.faces.map((i) => mixedThicknessRecording.baseline.faces[i].name));
  const feedback = await runMixedThickness([mixedThicknessSpec, spec], (sample) => {
    if (!at({ body_w: 800, t: 24 })(sample)) return;
    const faces = sample.faces.filter((f) => names.has(f.name));
    const max = Math.max(...faces.flatMap((f) => f.points.map((p) => p[0])));
    for (const f of faces) for (const p of f.points) if (Math.abs(p[0] - max) < 1e-6) p[0] += 2;
  });

  const changed = feedback[1].filter((f) => f.kind === "thickness_change");
  assert.deepEqual(
    changed.map(({ path, slider, part, measured }) => ({ path, slider, part, values: (measured as { values: unknown }).values })),
    [{ path: "thickness[0].options", slider: "body_w", part: "Carcass", values: { t: 24, body_w: 800 } }],
  );
  assert.match(changed[0].hint, /슬라이더 body_w가 두께 t=24에서 부품 Carcass의 두께를 바꿉니다/);
});

test("두께 쌍의 격자 샘플을 재계산하지 못하면 보강하지 않고 그 두께 선택을 가리키는 피드백으로 명세를 다시 쓴다", async () => {
  const feedback = await runMixedThickness([mixedThicknessSpec, mixedThicknessSpec, spec], (sample) => {
    if (!at({ body_w: 600, t: 24 })(sample)) return;
    sample.status = "recompute_failed";
    sample.faces = [];
  });

  // 교차 검증 피드백 뒤에 격자 샘플의 재계산 실패가 붙는다
  const failed = feedback[2].filter((f) => f.kind === "recompute_failed");
  assert.deepEqual(
    failed.map(({ path, slider, measured }) => ({ path, slider, measured })),
    [{ path: "thickness[0].options", slider: "body_w", measured: { values: { t: 24, body_w: 600 } } }],
  );
  assert.match(failed[0].hint, /두께 t와 body_w의 격자 보강 샘플을 뽑을 수 없습니다/);
});

test("두께 쌍의 격자 검증점에서 격자 보간이 Fusion과 맞지 않으면 그 두께 선택을 가리키는 피드백이 나온다", async () => {
  // 격자 마디 사이 t=24·전체 폭 700의 Fusion 형상을 통째로 3 mm 옮겼다
  const feedback = await runMixedThickness([mixedThicknessSpec, mixedThicknessSpec, spec], (sample) => {
    if (at({ body_w: 700, t: 24 })(sample)) for (const f of sample.faces) for (const p of f.points) p[0] += 3;
  });

  assert.ok(feedback[2].length > 0);
  for (const f of feedback[2]) {
    assert.equal(f.path, "thickness[0].options");
    assert.deepEqual((f.measured as { values: unknown }).values, { t: 24, body_w: 700 });
    assert.match(f.hint, /두께 t와 body_w는 격자 보간으로도 맞지 않습니다/);
  }
});

/** 서랍 폭(d5 = body_w - 40 mm)을 원하는 후보. d5는 자식 파라미터라 부모를 운영자가 고른다. */
const drawerWidthCandidates: Candidate[] = candidates.map((c) => ({ ...c, sliders: [{ parameter: "d5", name: "서랍 폭" }] }));
/** 전체 폭을 움직여 서랍 폭을 바꾸는 명세 */
const drawerWidthSpec: Spec = { ...spec, sliders: [{ ...spec.sliders[0], name: "서랍 폭", children: ["d5"] }] };

test("원하는 치수가 자식 파라미터면 카드에 부모 후보와 같이 변하는 치수가 적히고, 고른 부모가 그 이름의 슬라이더가 된다", async () => {
  const { ai, store, ports } = setup({ candidates: [drawerWidthCandidates], spec: [drawerWidthSpec] });
  const { human, shown } = choosing("c1", { d5: "body_w" });

  const result = await runPipeline({ bundle, intake, human, ports });

  assert.equal(result.status, "submitted", JSON.stringify(store.log.at(-1)));
  // 전체 폭을 300~900으로 움직이면 상품 전체와 몸통·서랍의 폭이 바뀐다. 바꾸려는 치수 "서랍 폭" 자신은 빼고 적는다.
  assert.deepEqual(shown[0][0].choices, [{ parameter: "d5", name: "서랍 폭", options: [{ parent: "body_w", alsoChanges: ["전체 폭", "몸통 폭"] }] }]);
  assert.deepEqual(shown[0][0].previews.map((p) => p.parameter), ["body_w"]);
  const [input] = ai.calls.spec as { candidate: { sliders: unknown[] } }[];
  assert.deepEqual(input.candidate.sliders, [{ parameter: "d5", name: "서랍 폭", parent: "body_w" }]);
  assert.deepEqual(store.log.find((e) => e.stage === "choice")!.detail, { candidate: "c1", parents: { d5: "body_w" } });
  assert.deepEqual(JSON.parse(store.submissions[0].files["spec.json"]).sliders[0].children, ["d5"]);
});

/** 서랍 안 깊이(d9 = drawer_d, drawer_d = body_d - 20 mm)를 원하는 후보. 수식을 거슬러 서랍 깊이·전체 깊이가 부모 후보다. */
const innerDepthCandidates: Candidate[] = candidates.map((c) => ({ ...c, sliders: [{ parameter: "d9", name: "서랍 안 깊이" }] }));

test("자식 치수의 부모 후보가 여럿이면 가까운 부모부터 카드에 보이고, 운영자가 고르지 않았거나 후보 밖의 부모를 고르면 멈춘다", async () => {
  const unchosen = setup({ candidates: [innerDepthCandidates] });
  const { human, shown } = choosing("c1");

  const result = await runPipeline({ bundle, intake, human, ports: unchosen.ports });

  assert.deepEqual(result, { status: "stopped", stage: "choice", reason: "서랍 안 깊이(d9)을 바꾸려고 움직일 부모를 고르세요(drawer_d, body_d)" });
  const [choice] = shown[0][0].choices;
  assert.deepEqual(choice.options.map((o) => o.parent), ["drawer_d", "body_d"]);
  assert.deepEqual(choice.options[1].alsoChanges, ["전체 깊이", "몸통 깊이", "서랍 깊이"]);

  const outside = setup({ candidates: [innerDepthCandidates] });
  const stopped = await runPipeline({ bundle, intake, human: choosing("c1", { d9: "body_w" }).human, ports: outside.ports });
  assert.deepEqual(stopped, { status: "stopped", stage: "choice", reason: "서랍 안 깊이(d9)을 바꾸려고 움직일 부모를 고르세요(drawer_d, body_d). body_w는 부모 후보가 아닙니다" });
});

test("명세가 고른 후보 카드의 슬라이더 이름을 쓰지 않거나 자식 치수를 children에 적지 않거나 수식이 따르지 않는 파라미터를 적으면 다시 묻는다", async () => {
  const wrong: Spec = { ...spec, sliders: [{ ...spec.sliders[0], name: "body_w", children: ["d6"] }] };
  const { ai, ports } = setup({ candidates: [drawerWidthCandidates], spec: [wrong, drawerWidthSpec] });

  const result = await runPipeline({ bundle, intake, human: choosing("c1").human, ports });

  assert.equal(result.status, "submitted");
  assert.deepEqual((ai.calls.spec[1] as { schemaErrors: string[] }).schemaErrors, [
    '/sliders/0/name: "body_w"에 Fusion 파라미터 이름(body_w)이 들어 있습니다. 고객이 보는 치수의 뜻으로 지으세요(예: "서랍 폭"). 이름이 뜻을 말하지 않는 파라미터는 bundle.sweeps의 response(단독 스윕의 축 반응)를 보고 지으세요',
    "/sliders/0/children: d6는 수식이 body_w를 따르지 않습니다(따르는 파라미터: d1, d5, d7)",
    '/sliders/0/name: 고른 후보 카드의 이름 "서랍 폭"이어야 합니다',
    '/sliders/0/children: 이 슬라이더로 바꾸는 치수 d5("서랍 폭")를 적어야 합니다',
  ]);
});

test("후보의 슬라이더 이름이 Fusion 파라미터 이름이거나, 자식 치수를 바꿀 부모가 모두 그 후보의 다른 슬라이더면 후보를 다시 묻는다", async () => {
  // 대소문자가 달라도, 다른 말과 섞여도 Fusion 파라미터 이름이다
  const fusionName = { ...candidates[0], sliders: [{ parameter: "d6", name: "D6 높이" }] };
  const noParentLeft = { ...candidates[1], sliders: [{ parameter: "body_w", name: "전체 폭" }, { parameter: "d5", name: "서랍 폭" }] };
  const { ai, ports } = setup({ candidates: [[fusionName, noParentLeft], candidates] });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  assert.deepEqual((ai.calls.candidates[1] as { schemaErrors: string[] }).schemaErrors, [
    '/0/sliders/0/name: "D6 높이"에 Fusion 파라미터 이름(D6)이 들어 있습니다. 고객이 보는 치수의 뜻으로 지으세요(예: "서랍 폭"). 이름이 뜻을 말하지 않는 파라미터는 bundle.sweeps의 response(단독 스윕의 축 반응)를 보고 지으세요',
    "/1/sliders/1/parameter: d5를 바꿀 부모(body_w)가 모두 이 후보의 다른 슬라이더입니다",
  ]);
});

test("UI 스타일 목록에 없는 스타일을 끝내 고르면 명세 작성으로 가지 않고 멈춘다", async () => {
  const { ai, ports } = setup({ style: [{ style: "neon" }, { style: "neon" }, { style: "neon" }, { style: "neon" }] });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status === "stopped" && result.stage, "style");
  assert.match(result.status === "stopped" ? result.reason : "", /\/style/);
  assert.equal(ai.calls.spec.length, 0);
});

test("목록에 없는 스타일은 형식 오류를 붙여 다시 묻고, 고른 스타일이 결과물에 담긴다", async () => {
  const { ai, store, ports } = setup({ style: [{ style: "neon" }, { style: "dark" }] });

  await runPipeline({ bundle, intake, human: approveFirst, ports });

  const asked = ai.calls.style as { styles: Style[]; schemaErrors: string[] }[];
  assert.deepEqual(asked[0].styles, UI_STYLES);
  assert.equal(asked[1].schemaErrors.length, 1);
  const { files } = store.submissions[0];
  assert.deepEqual(JSON.parse(files["style.json"]), UI_STYLES.find((s) => s.id === "dark"));
});

test("UI 스타일 목록의 스타일이 형식에 맞지 않으면 고르기 전에 멈춘다", async () => {
  const broken = { ...UI_STYLES[0], colors: { ...UI_STYLES[0].colors, accent: "red; } body { display: none" } };
  const ai = scriptedAi({ parts: [partsFound], candidates: [candidatesFor([spec])], style: [{ style: "natural" }], spec: [spec], judgment: [judged()] });
  const store = memoryStore({ styles: [broken], rules });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports: { fusion: offline, ai, store } });

  assert.equal(result.status === "stopped" && result.stage, "style");
  assert.match(result.status === "stopped" ? result.reason : "", /\/0\/colors\/accent/);
  assert.equal(ai.calls.style.length, 0);
});

/** AI 판정이 받은 입력 */
type JudgmentInput = { spec: Spec; renders: { name: string; values: Record<string, number>; image: string }[]; colors: { name: string; color: string }[] };

test("수치 검증·축 반응·교차 검증을 통과한 명세를 슬라이더 끝값과 쌍별 모서리 조합에서 렌더링해 AI 판정을 받는다", async () => {
  const { ai, ports } = setup({ spec: [widthHeightSpec] }, recordedFusion().port);

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const [input] = ai.calls.judgment as JudgmentInput[];
  assert.deepEqual(input.spec, widthHeightSpec);
  assert.deepEqual(
    input.renders.map((r) => r.name),
    [
      "body_w=400",
      "body_w=800",
      "body_h=500",
      "body_h=1000",
      "body_w=400·body_h=500",
      "body_w=400·body_h=1000",
      "body_w=800·body_h=500",
      "body_w=800·body_h=1000",
    ],
  );
  // 나머지 슬라이더는 기본값이다
  assert.deepEqual(input.renders[0].values, { body_w: 400, body_h: 700 });
  // 같은 축척이라 폭 끝값끼리 그림 폭이 다르다
  assert.ok(drawnWidth(input.renders[1].image) > drawnWidth(input.renders[0].image));
  assert.deepEqual(input.colors.map((c) => c.name).sort(), ["Carcass", "DrawerBox"]);
});

test("AI 판정은 수치 검증을 통과한 명세에만 돈다", async () => {
  const { ai, ports } = setup({ spec: [tooWide, spec] });

  await runPipeline({ bundle: nonlinearAt825(), intake, human: approveFirst, ports });

  assert.deepEqual((ai.calls.judgment as JudgmentInput[]).map((i) => i.spec), [spec]);
});

const gap = { image: "body_w=800", reason: "폭 끝값에서 서랍과 몸통 옆판 사이가 벌어져 뚫려 보임" };

test("AI 판정이 문제를 찾으면 그 렌더링을 저장하고 이미지 경로와 이유 한 줄을 담은 ai_judgment 피드백으로 명세를 다시 쓴다", async () => {
  const { ai, store, ports } = setup({ spec: [spec, spec], judgment: [judged(gap), judged()] });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const [, rewrite] = ai.calls.spec as { previous: Spec; feedback: Feedback[] }[];
  assert.deepEqual(rewrite.previous, spec);
  assert.deepEqual(rewrite.feedback, [
    {
      path: "sliders[0]",
      slider: "body_w",
      part: "",
      kind: "ai_judgment",
      measured: { image: "renders/1단 서랍장/body_w=800.png", values: { body_w: 800 }, reason: gap.reason },
      expected: "뚫림·겹침·비례 깨짐 없음",
      hint: "body_w=800에서 렌더링 판정 실패: 그 끝값을 범위에서 빼거나 affects의 형태 변경·위치 이동 부품 확인",
    },
  ]);
  assert.deepEqual(store.renders.map((r) => r.path), ["renders/1단 서랍장/body_w=800.png"]);
  const [input] = ai.calls.judgment as JudgmentInput[];
  assert.equal(store.renders[0].png.toString("base64"), input.renders[1].image);
  assert.deepEqual(verificationLog(store).map((d) => (d as { feedback: Feedback[] }).feedback.map((f) => f.kind)), [["ai_judgment"], []]);
});

test("AI 판정이 보내지 않은 렌더링을 가리키거나 이유가 한 줄이 아니면 형식 오류를 붙여 다시 묻는다", async () => {
  const { ai, ports } = setup({ judgment: [judged({ image: "body_w=900", reason: "뚫림" }, { image: "body_w=400", reason: "겹침\n두 줄" }), judged()] });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const [, again] = ai.calls.judgment as { schemaErrors: string[] }[];
  assert.match(again.schemaErrors.join("\n"), /\/problems\/0\/image: .*body_w=400, body_w=800/);
  assert.match(again.schemaErrors.join("\n"), /\/problems\/1\/reason/);
});

test("수치 검증·축 반응은 통과했는데 AI 판정만 3번 실패하면 마지막 판정 이유를 붙여 최종 승인으로 넘어간다", async () => {
  const reviews: { spec: Spec; judgment: Feedback[] }[] = [];
  const human: HumanPort = {
    chooseCandidate: () => Promise.resolve({ candidate: "c1" }),
    finalApproval: (review) => {
      reviews.push(review);
      return Promise.resolve({ decision: "approve" });
    },
  };
  const last = { image: "body_w=400", reason: "폭 끝값에서 서랍이 너무 좁아 비례가 깨짐" };
  const { ai, store, ports } = setup({ spec: [spec, spec, spec], judgment: [judged(gap), judged(gap), judged(last)] });

  const result = await runPipeline({ bundle, intake, human, ports });

  assert.equal(result.status, "submitted");
  assert.equal(ai.calls.spec.length, 3);
  assert.equal(reviews.length, 1);
  assert.deepEqual(reviews[0].spec, spec);
  assert.deepEqual(
    reviews[0].judgment.map((f) => f.measured),
    [{ image: "renders/1단 서랍장/body_w=400.png", values: { body_w: 400 }, reason: last.reason }],
  );
  assert.equal(store.submissions.length, 1);
});

test("판정 실패 사이에 수치 검증 실패가 끼면 판정 실패만 세어, 3번에 못 미치면 후보 제시로 돌아간다", async () => {
  const { ai, ports } = setup({
    candidates: [candidates, candidates],
    style: [{ style: "natural" }, { style: "natural" }],
    spec: [spec, tooWide, spec, tooWide, spec],
    judgment: [judged(gap), judged(gap), judged()],
  });

  const result = await runPipeline({ bundle: nonlinearAt825(), intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const proposals = ai.calls.candidates as { failures: { feedback: Feedback[] }[] }[];
  assert.equal(proposals.length, 2);
  assert.ok(proposals[1].failures[0].feedback.every((f) => f.kind === "dimension_error" || f.kind === "shape_error"), JSON.stringify(proposals[1].failures[0].feedback.map((f) => f.kind)));
});

test("AI 판정이 같은 렌더링을 여러 번 짚으면 이유를 이어 붙인 피드백 하나로 명세를 다시 쓴다", async () => {
  const overlap = { image: "body_w=800", reason: "서랍이 옆판에 파고듦" };
  const { ai, store, ports } = setup({ spec: [spec, spec], judgment: [judged(gap, overlap), judged()] });

  await runPipeline({ bundle, intake, human: approveFirst, ports });

  const [, rewrite] = ai.calls.spec as { feedback: Feedback[] }[];
  assert.deepEqual(rewrite.feedback.map((f) => (f.measured as { reason: string }).reason), [`${gap.reason}; ${overlap.reason}`]);
  assert.equal(store.renders.length, 1);
});

/** 후보 선택마다 정해 둔 후보를 차례로 고르고, 최종 승인마다 정해 둔 결정을 차례로 내는 사람. 받은 카드와 최종 승인 화면 값을 남긴다. */
function deciding(choices: string[], decisions: Awaited<ReturnType<HumanPort["finalApproval"]>>[]) {
  const shown: CandidateCard[][] = [];
  const reviews: Parameters<HumanPort["finalApproval"]>[0][] = [];
  const human: HumanPort = {
    chooseCandidate: (cards) => {
      shown.push(cards);
      return Promise.resolve({ candidate: choices[shown.length - 1] });
    },
    finalApproval: (review) => {
      reviews.push(review);
      return Promise.resolve(decisions[reviews.length - 1]);
    },
  };
  return { human, shown, reviews };
}

test("최종 승인에서 슬라이더 이름을 고치면 제출된 명세와 사례에 그 이름이 들어가고 처리 기록에 고친 내용이 남는다", async () => {
  const edits = { body_w: { name: "가로 길이" } };
  const { human } = deciding(["c1"], [{ decision: "approve", edits }]);
  const { store, ports } = setup();

  const result = await runPipeline({ bundle, intake, human, ports });

  assert.equal(result.status, "submitted");
  const submitted: Spec = JSON.parse(store.submissions[0].files["spec.json"]);
  assert.deepEqual(submitted, { ...spec, sliders: [{ ...spec.sliders[0], name: "가로 길이" }] });
  assert.deepEqual((await store.cases.list())[0].spec, submitted);
  assert.deepEqual(store.log.find((e) => e.stage === "approval")?.detail, { decision: "approve", edits });
});

test("최종 승인에서 범위를 넓히려 하면 막혀 그 까닭과 함께 다시 묻고, 좁힌 범위는 제출된 명세에 들어간다", async () => {
  const { human, reviews } = deciding(["c1"], [
    { decision: "approve", edits: { body_w: { min: 300, max: 700 } } },
    { decision: "approve", edits: { body_w: { min: 500, max: 700 } } },
  ]);
  const { store, ports } = setup();

  const result = await runPipeline({ bundle, intake, human, ports });

  assert.equal(result.status, "submitted");
  assert.deepEqual(reviews.map((r) => r.errors), [[], ["/body_w/min: 범위는 좁히기만 할 수 있습니다. 400 이상으로 적으세요"]]);
  // 다시 물을 때도 승인 전 명세를 보이고, 막힌 결정이 고친 내용을 화면이 다시 채우도록 넘긴다
  assert.deepEqual(reviews[1].spec, spec);
  assert.deepEqual(reviews.map((r) => r.edits), [{}, { body_w: { min: 300, max: 700 } }]);
  const submitted: Spec = JSON.parse(store.submissions[0].files["spec.json"]);
  assert.deepEqual([submitted.sliders[0].min, submitted.sliders[0].max, submitted.sliders[0].default], [500, 700, 600]);
});

test("최종 승인에서 반려하고 다른 후보를 고르면 후보 제시를 다시 하지 않고 이미 받은 후보 카드로 후보 선택에 돌아간다", async () => {
  const { human, shown } = deciding(["c1", "c2"], [{ decision: "reject", back: "choice" }, { decision: "approve" }]);
  const plusY = { ...spec, front: "+Y", axes: { W: "X", D: "Y", H: "Z" } };
  const { ai, store, ports } = setup({ style: [{ style: "natural" }, { style: "natural" }], spec: [spec, plusY], judgment: [judged(), judged()] });

  const result = await runPipeline({ bundle, intake, human, ports });

  assert.equal(result.status, "submitted");
  assert.equal(ai.calls.candidates.length, 1);
  assert.equal(shown.length, 2);
  assert.deepEqual(shown[1], shown[0]);
  const [stored] = await store.cases.list();
  assert.equal(stored.chosen.id, "c2");
  assert.deepEqual(stored.backToChoice.map((c) => c.id), ["c1"]);
  assert.deepEqual(stored.rejections, []);
  assert.deepEqual(
    store.log.filter((e) => e.stage === "approval").map((e) => e.detail),
    [{ decision: "reject", back: "choice" }, { decision: "approve" }],
  );
});

test("최종 승인에서 거절 이유를 적어 반려하면 그 문장이 후보 제시 입력에 들어가 새 후보를 만들고 처리 기록에 남는다", async () => {
  const reason = "폭 말고 높이를 바꾸고 싶다";
  const { human, shown } = deciding(["c1", "c1"], [{ decision: "reject", back: "candidates", reason }, { decision: "approve" }]);
  const { ai, store, ports } = setup({
    candidates: [candidates, candidates],
    style: [{ style: "natural" }, { style: "natural" }],
    spec: [spec, spec],
    judgment: [judged(), judged()],
  });

  const result = await runPipeline({ bundle, intake, human, ports });

  assert.equal(result.status, "submitted");
  const proposals = ai.calls.candidates as { rejections: { candidate: Candidate; reason: string }[] }[];
  assert.deepEqual(proposals[0].rejections, []);
  assert.deepEqual(proposals[1].rejections.map((r) => [r.candidate.id, r.reason]), [["c1", reason]]);
  assert.equal(shown.length, 2);
  assert.deepEqual(store.log.filter((e) => e.stage === "approval").map((e) => e.detail), [{ decision: "reject", back: "candidates", reason }, { decision: "approve" }]);
});

test("거절 이유가 비었거나 한 줄이 아니면 다시 묻는다", async () => {
  const { human, reviews } = deciding(["c1"], [
    { decision: "reject", back: "candidates", reason: "  " },
    { decision: "reject", back: "candidates", reason: "높이를\n바꾸고 싶다" },
    { decision: "approve" },
  ]);
  const { ai, ports } = setup();

  const result = await runPipeline({ bundle, intake, human, ports });

  assert.equal(result.status, "submitted");
  assert.equal(ai.calls.candidates.length, 1);
  assert.deepEqual(reviews.map((r) => r.errors), [[], ["/reason: 거절 이유를 한 줄로 적으세요"], ["/reason: 거절 이유를 한 줄로 적으세요"]]);
});

test("최종 승인에서 고친 슬라이더 이름에 Fusion 파라미터 이름이 들어 있으면 다시 묻는다", async () => {
  const { human, reviews } = deciding(["c1"], [{ decision: "approve", edits: { body_w: { name: "body_w 폭" } } }, { decision: "approve" }]);
  const { ports } = setup();

  await runPipeline({ bundle, intake, human, ports });

  assert.match(reviews[1].errors.join("\n"), /^\/sliders\/0\/name: "body_w 폭"에 Fusion 파라미터 이름\(body_w\)/);
});

test("최종 승인에서 좁힌 범위 끝이 기본값에서 step의 배수만큼 떨어지지 않았거나 한 값뿐이면 다시 묻는다", async () => {
  const { human, reviews } = deciding(["c1"], [
    { decision: "approve", edits: { body_w: { min: 455 } } },
    { decision: "approve", edits: { body_w: { min: 600, max: 600 } } },
    { decision: "approve" },
  ]);
  const { ports } = setup();

  await runPipeline({ bundle, intake, human, ports });

  assert.deepEqual(reviews.map((r) => r.errors), [
    [],
    ["/body_w/min: 기본값 600에서 step 10의 배수만큼 떨어진 값으로 적으세요(예: 450, 460)"],
    ["/body_w/max: 610 이상으로 적으세요. 범위가 한 값뿐이면 슬라이더를 움직일 수 없습니다"],
  ]);
});

test("최종 승인에서 좁힌 범위가 닿지 않는 위상 묶음은 제출된 스윕 데이터에서 빠진다", async () => {
  const shelfIntake: Intake = { name: "칸막이 선반", kind: "선반", memo: "폭 500~1300, 깊이 200~400", thickness: "ai" };
  const shelfCandidates: Candidate[] = [
    { id: "c1", front: "-Y", sliders: [{ parameter: "shelf_w", name: "전체 폭" }, { parameter: "shelf_d", name: "전체 깊이" }], showThickness: false, summary: "폭과 깊이", diff: "정면 -Y" },
    { id: "c2", front: "-Y", sliders: [{ parameter: "shelf_w", name: "전체 폭" }], showThickness: false, summary: "폭 하나", diff: "깊이 고정" },
  ];
  const ai = scriptedAi({ parts: [shelfParts], candidates: [shelfCandidates], style: [{ style: "natural" }], spec: [shelfSpec], judgment: [judged()] });
  const store = memoryStore({ styles, rules });
  const { human } = deciding(["c1"], [{ decision: "approve", edits: { shelf_w: { max: 1100 } } }]);

  const result = await runPipeline({ bundle: shelfRecording, intake: shelfIntake, human, ports: { fusion: recordedFusion(shelfCrossCorners).port, ai, store } });

  assert.equal(result.status, "submitted", JSON.stringify(store.log.at(-1)));
  const { files } = store.submissions[0];
  assert.equal(JSON.parse(files["spec.json"]).sliders[0].max, 1100);
  // 1200 위의 4칸 묶음은 빠지고 800 아래의 2칸 묶음만 남는다
  const ranges = JSON.parse(files["sweeps.json"]).sweeps.find((s: { parameter: string }) => s.parameter === "shelf_w").groups.map((g: { range: { min: number } }) => g.range.min);
  assert.deepEqual(ranges, [450]);
});

// 최종 확인 판정은 실행기가 남긴 처리 기록의 detail 모양을 읽는다. 실행기의 기록을 그대로 넣어 그 모양이 어긋나지 않는지 본다.
test("최종 확인 판정이 실행기의 처리 기록에서 후보를 다시 고른 것, 반려 두 경로, 범위 고치기를 사람 개입으로 찾는다", async () => {
  const reason = "정면을 반대로 보고 싶다";
  const { human } = deciding(
    ["c1", "c1", "c2", "c1"],
    [
      { decision: "reject", back: "choice" },
      { decision: "reject", back: "candidates", reason },
      { decision: "approve", edits: { body_w: { name: "가로 길이", max: 800 } } },
    ],
  );
  const { store, ports } = setup({
    candidates: [candidates, candidates, candidates],
    style: Array(4).fill({ style: "natural" }),
    // 처음 후보는 수치 검증에 4번 실패해 후보 제시로 돌아간다. 정면이 +Y인 c2의 명세는 정면을 따른다.
    spec: [tooWide, tooWide, tooWide, tooWide, spec, { ...spec, front: "+Y" }, spec],
    judgment: [judged(), judged(), judged()],
  });

  const result = await runPipeline({ bundle: nonlinearAt825(), intake, human, ports });

  const outcome = judgeRun(store.log, result);
  assert.equal(result.status, "submitted");
  assert.deepEqual(outcome.interventions, [
    "같은 후보로 검증을 통과하지 못해 후보를 다시 골랐다",
    "최종 승인에서 반려하고 다른 후보를 골랐다",
    `최종 승인에서 반려하고 후보를 다시 받았다: ${reason}`,
    "최종 승인에서 body_w의 범위를 고쳤다",
  ]);
  // 후보 제시로 돌아가기 전 마지막 시도가 서랍 치수 오차였다
  assert.equal(outcome.failure?.class, "engine");
  assert.ok(outcome.failure.evidence.includes("dimension_error: 슬라이더 body_w, 부품 DrawerBox"), JSON.stringify(outcome.failure.evidence));
});

test("최종 확인 판정이 실행기의 처리 기록에서 이름만 고친 최종 승인을 통과로 본다", async () => {
  const { human } = deciding(["c1"], [{ decision: "approve", edits: { body_w: { name: "가로 길이" } } }]);
  const { store, ports } = setup({ spec: [tooWide, spec], judgment: [judged()] });

  // 같은 후보 안에서 검증 피드백으로 명세를 고친 것은 자동 진행이다
  const result = await runPipeline({ bundle: nonlinearAt825(), intake, human, ports });

  assert.deepEqual(judgeRun(store.log, result), { passed: true, interventions: [], failure: null });
});
