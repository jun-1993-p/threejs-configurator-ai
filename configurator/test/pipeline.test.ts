// 경계 1: 상품 하나를 처리하는 파이프라인 실행. 입력은 서랍장 합성 녹화본, 정보 입력, 사람 결정 각본이다.
// AI는 각본대로 답하는 가짜, 저장소는 메모리 구현이다. Fusion 연결은 슬라이더가 하나면 호출되면 실패하는 가짜,
// 둘 이상이면 녹화한 교차 검증 샘플로 답하는 가짜다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import type { Spec } from "../src/engine.ts";
import type { Feedback } from "../pipeline/feedback.ts";
import { FUSION_NEEDED, FUSION_RECONNECTED, runPipeline, type Candidate, type FusionPort, type HumanPort, type Intake, type SampleRequest } from "../pipeline/runner.ts";
import { scriptedAi, type Script } from "../pipeline/scripted-ai.ts";
import { memoryStore } from "../pipeline/memory-store.ts";
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

const intake: Intake = { name: "1단 서랍장", kind: "서랍장", memo: "폭 400~800, 높이는 고정", thickness: "ai" };

const candidates: Candidate[] = [
  { id: "c1", front: "-Y", parents: ["body_w"], showThickness: false, summary: "전체 폭 하나", diff: "정면 -Y" },
  { id: "c2", front: "+Y", parents: ["body_w"], showThickness: false, summary: "전체 폭 하나", diff: "정면 +Y" },
];

const styles = [{ id: "natural" }, { id: "dark" }];

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

function setup(script: Partial<Script> = {}, fusion: FusionPort = offline) {
  const ai = scriptedAi({ candidates: [candidates], style: [{ style: "natural" }], spec: [spec], ...script });
  const store = memoryStore({ styles });
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
  assert.equal(errors.length, 3, errors.join("\n"));
  assert.match(errors.join("\n"), /\/sliders\/0\/affects\/shape.*Drawer/);
  assert.match(errors.join("\n"), /\/sliders\/0\/affects.*Carcass/);
  assert.match(errors.join("\n"), /\/sliders\/1\/id.*drawer_depth/);
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
const depthCandidates: Candidate[] = candidates.map((c) => ({ ...c, parents: ["body_d"] }));

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

test("후보가 개수형 파라미터나 스윕하지 않은 파라미터를 노출하면 이유를 붙여 후보를 다시 묻는다", async () => {
  const withCount = structuredClone(bundle);
  withCount.parameters.push({ name: "shelves", value: 2, unit: "", expression: "2", is_user: true, is_count: true });
  const counted = candidates.map((c, i) => ({ ...c, parents: [i === 0 ? "shelves" : "d5"] }));
  const { ai, ports } = setup({ candidates: [counted, candidates] });

  const result = await runPipeline({ bundle: withCount, intake, human: approveFirst, ports });

  assert.equal(result.status, "submitted");
  const errors = (ai.calls.candidates[1] as { schemaErrors: string[] }).schemaErrors;
  assert.deepEqual(errors, [
    "/0/parents/0: shelves는 개수형 파라미터라 슬라이더 후보가 될 수 없습니다",
    "/1/parents/0: d5는 스윕한 파라미터가 아닙니다",
  ]);
});

test("칸막이 수가 바뀌는 선반도 위상 묶음을 넘나드는 슬라이더로 검증을 통과해 제출된다", async () => {
  const shelfIntake: Intake = { name: "칸막이 선반", kind: "선반", memo: "폭 500~1300, 깊이 200~400", thickness: "ai" };
  const shelfCandidates: Candidate[] = [
    { id: "c1", front: "-Y", parents: ["shelf_w", "shelf_d"], showThickness: false, summary: "폭과 깊이", diff: "정면 -Y" },
    { id: "c2", front: "-Y", parents: ["shelf_w"], showThickness: false, summary: "폭 하나", diff: "깊이 고정" },
  ];
  const ai = scriptedAi({ candidates: [shelfCandidates], style: [{ style: "natural" }], spec: [shelfSpec] });
  const store = memoryStore({ styles });
  const fusion = recordedFusion(shelfCrossCorners);

  const result = await runPipeline({ bundle: shelfRecording, intake: shelfIntake, human: approveFirst, ports: { fusion: fusion.port, ai, store } });

  assert.equal(result.status, "submitted", JSON.stringify(store.log.at(-1)));
  assert.equal(fusion.requests.length, 1);
  const sweeps = JSON.parse(store.submissions[0].files["sweeps.json"]);
  assert.equal(sweeps.sweeps.find((s: { parameter: string }) => s.parameter === "shelf_w").groups.length, 2);
});

const shelfIntake: Intake = { name: "칸막이 선반", kind: "선반", memo: "폭 500~1300, 깊이 200~400", thickness: "show" };
const shelfCandidates: Candidate[] = [
  { id: "c1", front: "-Y", parents: ["shelf_w", "shelf_d"], showThickness: true, summary: "폭·깊이와 판재 두께", diff: "두께 선택 노출" },
  { id: "c2", front: "-Y", parents: ["shelf_w", "shelf_d"], showThickness: false, summary: "폭·깊이", diff: "두께 고정" },
];
/** 칸막이 선반 판재 두께 t(기본 18)의 두께 선택 */
const shelfThickness = { ids: ["t"], name: "판재 두께", default: 18, options: [15, 18, 24] };

/** 칸막이 선반 명세들을 차례로 쓰는 AI로 실행한다. 첫 명세의 재작성 이유(schemaErrors)를 돌려준다. */
async function shelfSchemaErrors(first: Spec, bundle: unknown = shelfRecording) {
  const ai = scriptedAi({ candidates: [shelfCandidates], style: [{ style: "natural" }], spec: [first, shelfSpec] });
  const store = memoryStore({ styles });
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

test("고정 두께 파라미터가 슬라이더의 자식에 있으면 명세를 다시 묻는다", async () => {
  const sliders = shelfSpec.sliders.map((s, i) => (i === 1 ? { ...s, children: ["t"] } : s));

  const errors = await shelfSchemaErrors({ ...shelfSpec, sliders, fixed: ["t"] });

  assert.deepEqual(errors, ["/fixed/0: t는 슬라이더 shelf_d의 children에 있어 고정할 수 없습니다"]);
});

/** 칸막이 선반 두께 선택 명세를 실행한다. Fusion 연결은 교차 검증 모서리와 두께 후보 형상으로 답한다. */
async function runShelfThickness(specs: Spec[], thicknessSamples: CrossSample[] = shelfThicknessSamples) {
  const ai = scriptedAi({ candidates: [shelfCandidates], style: [{ style: "natural" }], spec: specs });
  const store = memoryStore({ styles });
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
  const twoBoards = structuredClone(shelfRecording);
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
  const ai = scriptedAi({ candidates: [candidates], style: [{ style: "natural" }], spec: [mixedThicknessSpec, mixedThicknessSpec] });
  const store = memoryStore({ styles });
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
  const ai = scriptedAi({ candidates: [candidates], style: [{ style: "natural" }], spec: specs });
  const store = memoryStore({ styles });
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
