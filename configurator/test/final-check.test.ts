// 최종 확인: 상품마다 처리 기록과 실행 결과로 후보 선택·최종 승인 밖의 사람 개입을 찾고, 실패를 명세 문제와 엔진 한계로 나눈다.
import { test } from "node:test";
import assert from "node:assert/strict";

import { finalVerdict, judgeRun, unseenEvidence, type ProductRecord } from "../pipeline/final-check.ts";
import { recording } from "./recording.ts";
import type { Feedback } from "../pipeline/feedback.ts";
import { AI_FORMAT_FAILURE, type LogEntry, type PipelineResult, type Stage } from "../pipeline/runner.ts";

const entry = (stage: Stage, detail?: unknown): LogEntry => ({ product: "2단 책장", stage, at: "2026-11-03T00:00:00.000Z", ...(detail === undefined ? {} : { detail }) });

const feedback = (kind: Feedback["kind"], slider = "body_w", part = "Carcass"): Feedback => ({ path: "/sliders/0", slider, part, kind, measured: 1, expected: 0, hint: "" });

/** 업로드부터 후보 제시까지 */
const start = [entry("upload"), entry("intake"), entry("candidates", ["c1", "c2"])];

/** 후보 선택부터 검증 통과까지 */
const chooseAndVerify = (candidate = "c1", ...failed: Feedback[][]) => [
  entry("choice", { candidate, parents: {} }),
  entry("style", "natural"),
  ...failed.flatMap((f, attempt) => [entry("spec"), entry("assembly"), entry("verification", { attempt, feedback: f })]),
  entry("spec"),
  entry("assembly"),
  entry("verification", { attempt: failed.length, feedback: [] }),
];

const submitted: PipelineResult = { status: "submitted" };

test("후보 선택과 슬라이더 이름만 고친 최종 승인으로 끝난 상품은 통과다", () => {
  const log = [...start, ...chooseAndVerify("c1", [feedback("off_axis_change")]), entry("approval", { decision: "approve", edits: { body_w: { name: "가로" } } }), entry("submission")];

  assert.deepEqual(judgeRun(log, submitted), { passed: true, interventions: [], failure: null });
});

test("최종 승인에서 범위를 좁혔으면 사람 개입이고 명세 문제다", () => {
  const log = [...start, ...chooseAndVerify(), entry("approval", { decision: "approve", edits: { body_w: { name: "가로", max: 800 } } }), entry("submission")];

  assert.deepEqual(judgeRun(log, submitted), {
    passed: false,
    interventions: ["최종 승인에서 body_w의 범위를 고쳤다"],
    failure: { class: "spec", evidence: ["최종 승인에서 body_w의 범위를 고쳤다"] },
  });
});

test("최종 승인에서 반려하고 다른 후보를 고르거나 거절 이유로 후보를 다시 받았으면 사람 개입이다", () => {
  const log = [
    ...start,
    ...chooseAndVerify("c1"),
    entry("approval", { errors: ["/reason: 한 줄로 쓰세요"] }),
    entry("approval", { decision: "reject", back: "choice" }),
    ...chooseAndVerify("c2"),
    entry("approval", { decision: "reject", back: "candidates", reason: "높이도 바꾸고 싶다" }),
    entry("candidates", ["c3"]),
    ...chooseAndVerify("c3"),
    entry("approval", { decision: "approve" }),
    entry("submission"),
  ];

  const outcome = judgeRun(log, submitted);

  // 막힌 결정(errors)은 같은 최종 승인을 다시 묻는 것이라 개입으로 세지 않는다
  assert.deepEqual(outcome.interventions, ["최종 승인에서 반려하고 다른 후보를 골랐다", "최종 승인에서 반려하고 후보를 다시 받았다: 높이도 바꾸고 싶다"]);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.failure?.class, "spec");
});

test("같은 후보로 검증을 통과하지 못해 후보 제시로 돌아갔고 마지막 시도가 형상 오차면 엔진 한계다", () => {
  const spec = [feedback("off_axis_change")];
  const engine = [feedback("shape_error", "body_w", "DrawerBox")];
  const failedChoice = [entry("choice", { candidate: "c1", parents: {} }), entry("style", "natural"), ...[spec, spec, spec, engine].flatMap((f, attempt) => [entry("spec"), entry("assembly"), entry("verification", { attempt, feedback: f })])];
  const log = [...start, ...failedChoice, entry("candidates", ["c3"]), ...chooseAndVerify("c3"), entry("approval", { decision: "approve" }), entry("submission")];

  assert.deepEqual(judgeRun(log, submitted), {
    passed: false,
    interventions: ["같은 후보로 검증을 통과하지 못해 후보를 다시 골랐다"],
    failure: { class: "engine", evidence: ["같은 후보로 검증을 통과하지 못해 후보를 다시 골랐다", "shape_error: 슬라이더 body_w, 부품 DrawerBox"] },
  });
});

test("애드인이 추가 샘플을 뽑지 못해 검증에서 멈췄으면 엔진 한계이고, 같은 검증 단계라도 AI 판정 응답이 형식 검사를 끝내 통과하지 못해 멈췄으면 명세 문제다", () => {
  const stoppedAt = (reason: string) =>
    judgeRun([...start, entry("choice", { candidate: "c1", parents: {} }), entry("verification", { stopped: reason })], { status: "stopped", stage: "verification", reason });
  const addin = "애드인이 추가 샘플을 뽑지 못했습니다: 재계산 실패";
  // AI 판정은 검증 단계 안에서 묻는다(runner.ts의 judge)
  const format = `${AI_FORMAT_FAILURE}: /problems/0/image: must be equal to one of the allowed values`;

  assert.deepEqual(stoppedAt(addin), { passed: false, interventions: [], failure: { class: "engine", evidence: [`verification 단계에서 멈췄다: ${addin}`] } });
  assert.deepEqual(stoppedAt(format).failure, { class: "spec", evidence: [`verification 단계에서 멈췄다: ${format}`] });
});

test("업로드 묶음 형식 오류로 멈췄으면 엔진 한계다", () => {
  const reason = "업로드 묶음 형식 오류: /baseline/faces/0/geometry: must have required property 'type'";

  assert.equal(judgeRun([entry("upload", { stopped: reason })], { status: "stopped", stage: "upload", reason }).failure?.class, "engine");
});

test("앞선 시도에 형상 오차가 있어도 후보 제시로 돌아가기 전 마지막 시도가 축 반응 실패면 명세 문제다", () => {
  const spec = [feedback("missing_axis_change")];
  const engine = [feedback("shape_error")];
  const failedChoice = [entry("choice", { candidate: "c1", parents: {} }), entry("style", "natural"), ...[engine, engine, engine, spec].flatMap((f, attempt) => [entry("spec"), entry("assembly"), entry("verification", { attempt, feedback: f })])];
  const log = [...start, ...failedChoice, entry("candidates", ["c3"]), ...chooseAndVerify("c3"), entry("approval", { decision: "approve" }), entry("submission")];

  assert.deepEqual(judgeRun(log, submitted).failure, {
    class: "spec",
    evidence: ["같은 후보로 검증을 통과하지 못해 후보를 다시 골랐다", "missing_axis_change: 슬라이더 body_w, 부품 Carcass"],
  });
});

const CORE = "core-tree-1";
const unseen = unseenEvidence(recording, []);
const record = (id: string, passed: boolean, core = CORE): ProductRecord => ({
  id,
  at: "2026-11-03T00:00:00.000Z",
  core,
  unseen,
  result: submitted,
  outcome: passed ? { passed, interventions: [], failure: null } : { passed, interventions: ["최종 승인에서 body_w의 범위를 고쳤다"], failure: { class: "spec", evidence: [] } },
});
const ids = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);

test("10개 중 8개가 후보 선택과 최종 승인만으로 끝났으면 최종 확인 통과이고, 7개면 불통과다", () => {
  const eight = ids.map((id, i) => record(id, i < 8));
  const seven = ids.map((id, i) => record(id, i < 7));

  assert.deepEqual(finalVerdict({ products: ids, core: CORE, records: eight }), { status: "passed", passed: 8, total: 10, missing: [], problems: [] });
  assert.equal(finalVerdict({ products: ids, core: CORE, records: seven }).status, "failed");
});

test("돌리지 않은 상품이 남았으면 판정하지 않는다", () => {
  const verdict = finalVerdict({ products: ids, core: CORE, records: ids.slice(0, 9).map((id) => record(id, true)) });

  assert.deepEqual(verdict, { status: "running", passed: 9, total: 10, missing: ["p10"], problems: [] });
});

test("최종 확인 중에 고정 코어나 변형 엔진이 바뀐 상품이 있으면 판정이 무효다", () => {
  const records = ids.map((id) => record(id, true, id === "p4" ? "core-tree-2" : CORE));

  const verdict = finalVerdict({ products: ids, core: CORE, records });

  assert.equal(verdict.status, "invalid");
  assert.deepEqual(verdict.problems, ["p4: 고정 코어·변형 엔진이 최종 확인을 시작할 때와 다르다(core-tree-2, 시작 core-tree-1)"]);
});

test("파라미터 이름과 부품 이름이 같은 개발 중 녹화본이 있으면 처음 보는 상품이 아니다", () => {
  // 같은 모델의 기본값만 바꿔 다시 업로드하면 점 좌표·파라미터 값·수식은 달라도 파라미터와 부품의 이름은 같다
  const resized = structuredClone(recording);
  resized.baseline.faces[0].points[0][0] += 0.001;
  resized.parameters[0].value += 10;
  resized.parameters[0].expression = `${resized.parameters[0].value} mm`;
  const other = structuredClone(recording);
  other.parameters[0].name = "다른_파라미터";

  assert.deepEqual(unseenEvidence(resized, [{ path: "fixtures/private/recordings/drawer.json", bundle: recording }]).matches, ["fixtures/private/recordings/drawer.json"]);
  const evidence = unseenEvidence(other, [{ path: "fixtures/private/recordings/drawer.json", bundle: recording }]);
  assert.deepEqual(evidence.matches, []);
  assert.equal(evidence.compared, 1);
  assert.notEqual(evidence.fingerprint, unseenEvidence(recording, []).fingerprint);
});

test("개발 중 녹화본과 겹친 상품이 기록에 있으면 판정이 무효다", () => {
  const seen = { ...record("p2", true), unseen: { ...unseen, matches: ["fixtures/synthetic/drawer.json"] } };
  const records = ids.map((id) => (id === "p2" ? seen : record(id, true)));

  assert.deepEqual(finalVerdict({ products: ids, core: CORE, records }).problems, ["p2: 개발 중 녹화본과 같은 모델이다(fixtures/synthetic/drawer.json)"]);
});
