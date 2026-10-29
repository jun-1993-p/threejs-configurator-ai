// 경계 1: 상품 하나를 처리하는 파이프라인 실행. 입력은 서랍장 합성 녹화본, 정보 입력, 사람 결정 각본이다.
// AI는 각본대로 답하는 가짜, 저장소는 메모리 구현, Fusion 연결은 호출되면 실패하는 가짜다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import type { Spec } from "../src/engine.ts";
import { runPipeline, type Candidate, type FusionPort, type HumanPort, type Intake } from "../pipeline/runner.ts";
import { scriptedAi, type Script } from "../pipeline/scripted-ai.ts";
import { memoryStore } from "../pipeline/memory-store.ts";

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
