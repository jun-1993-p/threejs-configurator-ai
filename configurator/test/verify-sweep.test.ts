// 업로드 때 알리는 스윕 문제: 보간 실패(ADR-0007)와 부피 튐 경고. 서랍장·칸막이 선반 합성 녹화본을 바꿔 확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";

import { uploadSweepFeedback } from "../pipeline/verify-sweep.ts";
import { recording, shelfRecording } from "./recording.ts";

test("업로드 때 보간 실패한 파라미터를 슬라이더 후보에서 뺀다고 알린다", () => {
  const bundle = structuredClone(recording);
  bundle.sweeps.find((s) => s.parameter === "body_h")!.interpolation_failure = { at: 412.5, kind: "shape_error", part: "Carcass", error: 3.2, tolerance: 1 };

  const feedback = uploadSweepFeedback(bundle);

  assert.deepEqual(
    feedback.map(({ path, slider, part, kind, measured, expected }) => ({ path, slider, part, kind, measured, expected })),
    [{ path: "", slider: "body_h", part: "Carcass", kind: "shape_error", measured: { at: 412.5, error: 3.2 }, expected: { max_error_mm: 1 } }],
  );
  assert.match(feedback[0].hint, /17점.*412\.5.*형상 오차 3\.2 mm.*합격선 1 mm.*슬라이더 후보에서 뺍니다/);
});

test("샘플 부피가 이웃 샘플로 만든 보간에서 크게 벗어나면 실패가 아닌 volume_jump 경고를 남긴다", () => {
  const bundle = structuredClone(recording);
  const sample = bundle.sweeps.find((s) => s.parameter === "body_w")!.samples.find((s) => s.value === 600)!;
  const carcass = sample.bodies!.find((b) => b.name === "Carcass")!;
  const expected = carcass.volume;
  carcass.volume *= 1.5;

  const all = uploadSweepFeedback(bundle);

  // 튄 샘플을 양옆에 둔 이웃 샘플도 보간이 빗나가 함께 경고될 수 있다
  assert.deepEqual(new Set(all.map((f) => f.kind)), new Set(["volume_jump"]));
  const feedback = all.find((f) => (f.measured as { value: number }).value === 600)!;
  assert.deepEqual(
    { path: feedback.path, slider: feedback.slider, part: feedback.part, kind: feedback.kind },
    { path: "", slider: "body_w", part: "Carcass", kind: "volume_jump" },
  );
  assert.deepEqual(feedback.measured, { value: 600, body: "Carcass", volume: Math.round(expected * 1.5) });
  // 서랍장 몸통 부피는 폭에 선형이라 이웃 샘플(450, 750)의 보간이 원래 부피와 같다
  assert.ok(Math.abs((feedback.expected as { volume: number }).volume - expected) < 1);
  assert.match(feedback.hint, /body_w=600에서 바디 Carcass의 부피가 이웃 샘플\(450, 750\)로 보간한 값보다 50% 큽니다.*경고/);
});

test("부피가 고르게 변하는 녹화본은 부피 튐으로 알리지 않는다", () => {
  assert.deepEqual(uploadSweepFeedback(recording), []);
  assert.deepEqual(uploadSweepFeedback(shelfRecording), []);
});

test("이웃 샘플로 보간한 부피와 샘플 부피가 모두 0이면 부피 튐이 아니다", () => {
  const bundle = structuredClone(recording);
  for (const sample of bundle.sweeps.find((s) => s.parameter === "body_w")!.samples) {
    if ([450, 600, 750].includes(sample.value)) sample.bodies!.find((b) => b.name === "Carcass")!.volume = 0;
  }

  const at600 = uploadSweepFeedback(bundle).filter((f) => (f.measured as { value: number }).value === 600);

  assert.deepEqual(at600, []);
});

test("위상 묶음 경계에서 부피가 바뀌어도 다른 위상 묶음의 샘플끼리는 견주지 않는다", () => {
  // 칸막이 선반은 폭 800·1200에서 칸막이가 하나씩 는다. 늘어난 칸막이가 몸통 바디에 붙은 것처럼 몸통 부피를 묶음마다 5,000,000 mm³씩 키운다.
  const bundle = structuredClone(shelfRecording);
  const width = bundle.sweeps.find((s) => s.parameter === "shelf_w")!;
  for (const sample of width.samples) {
    const extra = sample.value >= 1200.03 ? 2 : sample.value >= 800.02 ? 1 : 0;
    sample.bodies!.find((b) => b.name === "Carcass")!.volume += extra * 5_000_000;
  }

  assert.deepEqual(uploadSweepFeedback(bundle), []);
});
