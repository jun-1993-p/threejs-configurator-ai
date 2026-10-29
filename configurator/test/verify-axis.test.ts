// 경계 2: 축 반응 검증. 단독 스윕의 Fusion 형상에서 슬라이더마다 부품이 어느 축으로 어떻게 바뀌는지 재,
// 명세의 형태 변경 부품·위치 이동 부품과 비교한다. 입력은 깊이 축 슬라이더가 둘(전체 깊이·서랍 깊이)인 서랍장 합성 녹화본이다.
import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyAxisResponse } from "../pipeline/verify-axis.ts";
import { depthSpec as spec, facesOf, movePart, recording } from "./recording.ts";

test("깊이 축의 두 슬라이더가 각자 맡은 부품만 바꾸면 통과한다", () => {
  assert.deepEqual(verifyAxisResponse(spec, recording), []);
});

/** i번째 슬라이더의 affects를 바꾼 명세 */
const withAffects = (i: number, affects: { shape: string[]; move: string[] }) => ({
  ...spec,
  sliders: spec.sliders.map((s, j) => (j === i ? { ...s, affects } : s)),
});

const brief = ({ path, slider, part, kind }: { path: string; slider: string; part: string; kind: string }) => ({ path, slider, part, kind });

test("형태 변경 부품의 해당 축 치수가 바뀌지 않으면 그 부품에서 실패한다", () => {
  // 서랍 깊이는 몸통을 바꾸지 않는다
  const feedback = verifyAxisResponse(withAffects(1, { shape: ["DrawerBox", "Carcass"], move: [] }), recording);

  assert.deepEqual(feedback.map(brief), [
    { path: "sliders[1].affects.shape", slider: "drawer_d", part: "Carcass", kind: "missing_axis_change" },
  ]);
  assert.match(feedback[0].hint, /Carcass/);
});

test("선언하지 않은 부품의 치수가 바뀌면 형태 변경 부품에 넣으라고 실패한다", () => {
  // 전체 깊이는 서랍 깊이도 바꾼다(drawer_d = body_d - 20)
  const feedback = verifyAxisResponse(withAffects(0, { shape: ["Carcass"], move: [] }), recording);

  assert.deepEqual(feedback.map(brief), [
    { path: "sliders[0].affects.shape", slider: "body_d", part: "DrawerBox", kind: "unexpected_shape_change" },
  ]);
  // 300~600 범위의 샘플·검증점 중 가장 크게 바뀐 값: 337.5(기본 450에서 112.5 mm, 앞면이 고정이라 가운데는 절반)
  assert.deepEqual(feedback[0].measured, { value: 337.5, axis: "D", size_delta_mm: -112.5, move_mm: -56.25 });
});

test("위치 이동 부품의 치수가 바뀌면 위치 이동 부품에서 빼라고 실패한다", () => {
  const feedback = verifyAxisResponse(withAffects(0, { shape: ["Carcass"], move: ["DrawerBox"] }), recording);

  assert.deepEqual(feedback.map(brief), [
    { path: "sliders[0].affects.move", slider: "body_d", part: "DrawerBox", kind: "unexpected_shape_change" },
  ]);
  assert.equal(feedback[0].expected, "위치 이동만");
});

test("슬라이더의 축이 아닌 축의 치수가 바뀌면 다른 축 변화로 실패한다", () => {
  // 서랍 깊이를 폭 슬라이더로 잘못 적었다
  const wrongAxis = { ...spec, sliders: spec.sliders.map((s, j) => (j === 1 ? { ...s, axis: "W" as const } : s)) };

  const feedback = verifyAxisResponse(wrongAxis, recording);

  assert.deepEqual(feedback.map(brief), [
    { path: "sliders[1].affects.shape", slider: "drawer_d", part: "DrawerBox", kind: "missing_axis_change" },
    { path: "sliders[1].axis", slider: "drawer_d", part: "DrawerBox", kind: "off_axis_change" },
  ]);
  // 300~600 범위의 샘플·검증점 중 가장 크게 바뀐 값: 검증점 591.25(기본 430에서 161.25 mm)
  assert.deepEqual(feedback[1].measured, { value: 591.25, axis: "D", size_delta_mm: 161.25, move_mm: 80.625 });
  assert.match(feedback[1].hint, /DrawerBox.*D/);
});

/** 전체 높이 슬라이더 하나인 명세. 녹화본에서 높이는 몸통만 바꾼다. */
const heightSpec = (move: string[]) => ({
  ...spec,
  sliders: [
    {
      ...spec.sliders[0],
      id: "body_h",
      name: "전체 높이",
      axis: "H" as const,
      min: 500, max: 900, default: 700,
      affects: { shape: ["Carcass"], move },
    },
  ],
});

/** 높이가 늘면 서랍이 그 절반만큼 올라가는 녹화본(위치 이동 부품) */
const raisedDrawer = movePart("body_h", 700, "DrawerBox", "Z", 0.5);

test("위치 이동 부품이 치수는 그대로이고 축 방향 자리만 옮겨지면 통과한다", () => {
  assert.deepEqual(verifyAxisResponse(heightSpec(["DrawerBox"]), raisedDrawer), []);
});

test("위치 이동 부품의 자리가 축 방향으로 옮겨지지 않으면 실패한다", () => {
  const feedback = verifyAxisResponse(heightSpec(["DrawerBox"]), recording);

  assert.deepEqual(feedback.map(brief), [
    { path: "sliders[0].affects.move", slider: "body_h", part: "DrawerBox", kind: "missing_axis_change" },
  ]);
});

test("선언하지 않은 부품의 자리가 옮겨지면 위치 이동 부품에 넣으라고 실패한다", () => {
  const feedback = verifyAxisResponse(heightSpec([]), raisedDrawer);

  assert.deepEqual(feedback.map(brief), [
    { path: "sliders[0].affects.move", slider: "body_h", part: "DrawerBox", kind: "unexpected_move" },
  ]);
  assert.match(feedback[0].hint, /DrawerBox.*affects\.move/);
});

test("범위 안 어느 샘플에서든 축 방향으로 옮겨지면 위치 이동으로 본다", () => {
  // 높이 1 mm당 0.002 mm: 612.5·787.5에서는 0.175 mm로 문턱 안이지만 525·875에서는 0.35 mm다
  const slightly = movePart("body_h", 700, "DrawerBox", "Z", 0.002);

  assert.deepEqual(verifyAxisResponse(heightSpec(["DrawerBox"]), slightly), []);
});

test("샘플의 면 구성이 기본 형상과 달라도 부품을 바디의 모든 면으로 잰다", () => {
  // 높이 스윕의 모든 샘플·검증점에서 몸통 면 이름이 바뀌었다(위상 변화). 몸통을 선언하지 않은 명세는 몸통 변화로 실패해야 한다.
  const renamed = structuredClone(raisedDrawer);
  const carcass = facesOf("Carcass");
  const height = renamed.sweeps.find((s) => s.parameter === "body_h")!;
  for (const shape of [...height.samples, ...height.checks]) {
    for (const f of shape.faces) if (carcass.has(f.name)) f.name = `${f.name}~new`;
  }
  const undeclared = { ...heightSpec(["DrawerBox"]), sliders: heightSpec(["DrawerBox"]).sliders.map((s) => ({ ...s, affects: { shape: [], move: ["DrawerBox"] } })) };

  assert.deepEqual(verifyAxisResponse(undeclared, renamed).map(brief), [
    { path: "sliders[0].affects.shape", slider: "body_h", part: "Carcass", kind: "unexpected_shape_change" },
  ]);
});
