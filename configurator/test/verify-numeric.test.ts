// 경계 2: 수치 검증. 검증점에서 변형 엔진 결과와 녹화된 Fusion 형상을 비교한다(ADR-0012).
// 입력은 서랍장 합성 녹화본이다. 합격선 밖의 경우는 녹화된 검증점 형상을 조금 바꿔 만든다.
import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyNumeric } from "../pipeline/verify-numeric.ts";
import { AXIS, drawerSpec as spec, facesOf, pushMaxSide, recording, withCheck } from "./recording.ts";

test("서랍장 녹화본은 슬라이더 범위 안의 모든 검증점에서 합격선 안이다", () => {
  assert.deepEqual(verifyNumeric(spec, recording, recording), []);
});

test("부품 치수가 검증점에서 0.2 mm 넘게 어긋나면 그 부품의 치수 오차로 실패한다", () => {
  const wide = { ...spec, sliders: [{ ...spec.sliders[0], max: 900 }] };
  const bundle = pushMaxSide(825, "DrawerBox", "X", 0.3);

  const feedback = verifyNumeric(wide, bundle, bundle);

  const w = feedback.find((f) => f.kind === "dimension_error" && f.part === "DrawerBox");
  assert.ok(w, JSON.stringify(feedback));
  assert.equal(w.path, "sliders[0].max");
  assert.equal(w.slider, "body_w");
  // 서랍 폭 = body_w - 40 = 785, 녹화본은 0.3 mm 넓게 바꿨다
  assert.deepEqual(w.measured, { value: 825, dimension: "W", engine_mm: 785, fusion_mm: 785.3, error_mm: 0.3 });
  assert.deepEqual(w.expected, { max_error_mm: 0.2 });
  assert.match(w.hint, /max.*825/);
  assert.ok(!feedback.some((f) => f.part === "Carcass"), "바꾸지 않은 부품은 통과한다");
});

/** 부품의 한 면에서 가운데에 가장 가까운 점(경계가 아닌 안쪽 점)을 축 방향으로 delta만큼 민다 */
function moveInnerPoint(value: number, part: string, face: number, axis: keyof typeof AXIS, delta: number) {
  const name = [...facesOf(part)][face];
  return withCheck(value, (check) => {
    const points = check.faces.find((f) => f.name === name)!.points;
    const center = [0, 1, 2].map((c) => points.reduce((s, p) => s + p[c], 0) / points.length);
    const near = points.reduce((a, b) => (Math.hypot(...b.map((v, c) => v - center[c])) < Math.hypot(...a.map((v, c) => v - center[c])) ? b : a));
    near[AXIS[axis]] += delta;
  });
}

test("꼭짓점이 max(1 mm, 대각선 0.1%) 넘게 어긋나면 형상 오차로 실패하고, 그 안이면 통과한다", () => {
  const wide = { ...spec, sliders: [{ ...spec.sliders[0], max: 900 }] };
  // 몸통 뒷판 안쪽 점을 면을 따라 옮기므로 부품 치수는 그대로다.
  // body_w=825에서 Fusion 형상 대각선 = √(825² + 450² + 700²) ≈ 1171.8 mm, 합격선 ≈ 1.1718 mm
  const back = [...facesOf("Carcass")].findIndex((n) => {
    const f = recording.baseline.faces.find((x) => x.name === n)!;
    return Math.abs(f.points[0][1] - 450) < 1e-6 && f.points.every((p) => Math.abs(p[1] - 450) < 1e-6);
  });
  const far = moveInnerPoint(825, "Carcass", back, "X", 1.3);
  const near = moveInnerPoint(825, "Carcass", back, "X", 1.1);

  const feedback = verifyNumeric(wide, far, far);

  assert.deepEqual(
    feedback.map(({ part, kind, path }) => ({ part, kind, path })),
    [{ part: "Carcass", kind: "shape_error", path: "sliders[0].max" }],
  );
  assert.deepEqual(feedback[0].measured, { value: 825, error_mm: 1.3 });
  assert.deepEqual(feedback[0].expected, { max_error_mm: 1.1718 });
  assert.deepEqual(verifyNumeric(wide, near, near), []);
});

test("판재 두께가 검증점에서 0.2 mm 넘게 어긋나면 두께의 치수 오차로 실패한다", () => {
  const wide = { ...spec, sliders: [{ ...spec.sliders[0], max: 900 }] };
  // 서랍 오른쪽 판의 안쪽 면(법선 -X)을 0.3 mm 안으로 밀어 판 두께를 18 → 18.3 mm로 만든다. 바깥 치수는 그대로다.
  const inner = recording.baseline.faces.find(
    (f, i) =>
      recording.parts.find((p) => p.name === "DrawerBox")!.faces.includes(i) &&
      f.geometry?.type === "plane" &&
      f.geometry.normal[0] < -0.999 &&
      f.points[0][0] > 0,
  )!;
  const bundle = withCheck(825, (check) => {
    for (const p of check.faces.find((f) => f.name === inner.name)!.points) p[0] -= 0.3;
  });

  const feedback = verifyNumeric(wide, bundle, bundle);

  assert.deepEqual(
    feedback.map(({ part, kind }) => ({ part, kind })),
    [{ part: "DrawerBox", kind: "dimension_error" }],
  );
  const { faces, ...measured } = feedback[0].measured as { faces: string[] };
  assert.deepEqual(measured, { value: 825, dimension: "thickness", engine_mm: 18, fusion_mm: 18.3, error_mm: 0.3 });
  assert.ok(faces.includes(inner.name));
});

test("슬라이더 범위 밖의 검증점은 보지 않는다", () => {
  // 명세의 body_w 범위는 400~800이라 825의 검증점은 고객이 쓰지 않는다
  const bundle = pushMaxSide(825, "DrawerBox", "X", 0.3);

  assert.deepEqual(verifyNumeric(spec, bundle, bundle), []);
});

test("범위 안의 검증점이 재계산에 실패했거나 면 구성이 다르면 그 값에서 실패한다", () => {
  const failed = withCheck(525, (check) => {
    check.status = "recompute_failed";
    check.faces = [];
  });
  const changed = withCheck(675, (check) => void check.faces.pop());

  const [recompute] = verifyNumeric(spec, failed, failed);
  const [topology] = verifyNumeric(spec, changed, changed);

  assert.deepEqual(
    { ...recompute, hint: undefined },
    { path: "sliders[0].min", slider: "body_w", part: "", kind: "recompute_failed", measured: { value: 525 }, expected: "재계산 성공", hint: undefined },
  );
  assert.match(recompute.hint, /min.*525/);
  assert.equal(topology.kind, "topology_change");
  assert.equal(topology.path, "sliders[0].max");
});
