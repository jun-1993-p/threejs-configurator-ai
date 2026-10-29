// 경계 1: 상품 하나를 처리하는 파이프라인 실행. 입력은 서랍장 합성 녹화본, 정보 입력, 사람 결정 각본이다.
// AI는 각본대로 답하는 가짜, 저장소는 메모리 구현, Fusion 연결은 호출되면 실패하는 가짜다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import type { Spec } from "../src/engine.ts";
import type { Feedback } from "../pipeline/feedback.ts";
import { runPipeline, type Candidate, type FusionPort, type HumanPort, type Intake } from "../pipeline/runner.ts";
import { scriptedAi, type Script } from "../pipeline/scripted-ai.ts";
import { memoryStore } from "../pipeline/memory-store.ts";
import { depthSpec, pushMaxSide } from "./recording.ts";

const fixtures = new URL("../../fixtures/synthetic/", import.meta.url);
const bundle = JSON.parse(readFileSync(new URL("drawer.json", fixtures), "utf-8"));
const spec: Spec = JSON.parse(readFileSync(new URL("drawer.spec.json", fixtures), "utf-8"));

const intake: Intake = { name: "1단 서랍장", kind: "서랍장", memo: "폭 400~800, 높이는 고정", thickness: "ai" };

const candidates: Candidate[] = [
  { id: "c1", front: "-Y", parents: ["body_w"], showThickness: false, summary: "전체 폭 하나", diff: "정면 -Y" },
  { id: "c2", front: "+Y", parents: ["body_w"], showThickness: false, summary: "전체 폭 하나", diff: "정면 +Y" },
];

const styles = [{ id: "natural" }, { id: "dark" }];

const offline: FusionPort = {
  requestSamples: () => Promise.reject(new Error("이 시험에서는 추가 샘플을 요청하지 않는다")),
};

const approveFirst: HumanPort = {
  chooseCandidate: () => Promise.resolve({ candidate: "c1" }),
  finalApproval: () => Promise.resolve({ decision: "approve" }),
};

function setup(script: Partial<Script> = {}) {
  const ai = scriptedAi({ candidates: [candidates], style: [{ style: "natural" }], spec: [spec], ...script });
  const store = memoryStore({ styles });
  return { ai, store, ports: { fusion: offline, ai, store } };
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

test("최종 승인에서 승인하면 고정 코어·명세·스윕 데이터로 된 결과물이 제출된다", async () => {
  const { store, ports } = setup();

  await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(store.submissions.length, 1);
  const { product, files } = store.submissions[0];
  assert.equal(product, "1단 서랍장");
  assert.deepEqual(JSON.parse(files["spec.json"]), spec);
  assert.deepEqual(JSON.parse(files["sweeps.json"]).sweeps.map((s: { parameter: string }) => s.parameter), ["body_w"]);
  assert.match(files["index.html"], /<div data-configurator data-spec="spec\.json" data-sweeps="sweeps\.json"><\/div>/);
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

  assert.deepEqual(store.cases, [{ kind: "서랍장", intake, candidates, chosen: "c1", spec }]);
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
  assert.deepEqual(proposals[1].failures[0].candidate, candidates[0]);
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

test("한 축에 슬라이더가 둘인 명세에서 축 반응이 틀리면 부품과 명세 위치를 담은 피드백으로 다시 쓰고, 고친 명세로 제출한다", async () => {
  const depthIntake = { ...intake, memo: "전체 깊이와 서랍 깊이" };
  const { ai, store, ports } = setup({ spec: [drawerMissing(depthSpec), depthSpec] });

  const result = await runPipeline({ bundle, intake: depthIntake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const asked = ai.calls.spec as { feedback: Feedback[] }[];
  assert.deepEqual(
    asked[1].feedback.map(({ path, slider, part, kind }) => ({ path, slider, part, kind })),
    [{ path: "sliders[0].affects.shape", slider: "body_d", part: "DrawerBox", kind: "unexpected_shape_change" }],
  );
  assert.deepEqual(JSON.parse(store.submissions[0].files["spec.json"]), depthSpec);
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
  const { ai, ports } = setup({ spec: [wrongNames, depthSpec] });

  const result = await runPipeline({ bundle, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const errors = (ai.calls.spec[1] as { schemaErrors: string[] }).schemaErrors;
  assert.equal(errors.length, 3, errors.join("\n"));
  assert.match(errors.join("\n"), /\/sliders\/0\/affects\/shape.*Drawer/);
  assert.match(errors.join("\n"), /\/sliders\/0\/affects.*Carcass/);
  assert.match(errors.join("\n"), /\/sliders\/1\/id.*drawer_depth/);
});
