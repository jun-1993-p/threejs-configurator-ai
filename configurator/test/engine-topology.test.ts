// 변형 엔진의 위상 묶음(ADR-0005) 경계 테스트. 입력은 칸막이 선반 합성 녹화본, 정답은 녹화된 형상이다.
// 선반은 전체 폭 800·1200에서 칸 수가 2·3·4로 바뀌며 칸막이 바디가 하나씩 늘어난다(solidcraft-test/shelf.sc).
import { test } from "node:test";
import assert from "node:assert/strict";

import { createMorph, faceKey, type MorphShape, type SampleFace } from "../src/engine.ts";
import { boundsOf, diagonal } from "../pipeline/measure.ts";
import { shapeTolerance } from "../pipeline/verify-numeric.ts";
import { shelfCrossChecks, shelfRecording as recording, shelfSpec as spec } from "./recording.ts";

const width = recording.sweeps.find((s) => s.parameter === "shelf_w")!;

/** 녹화된 면 점을 엔진 형상의 면 순서대로 이어 붙인다. 면 구성이 다르면 실패한다. */
function recordedPositions(shape: MorphShape, faces: SampleFace[]): number[] {
  const byKey = new Map(faces.map((f) => [faceKey(f), f]));
  assert.deepEqual(new Set(byKey.keys()), new Set(shape.faces.map(faceKey)), "면 구성이 녹화본과 다르다");
  return shape.faces.flatMap((f) => byKey.get(faceKey(f))!.points.flat());
}

function maxDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  assert.equal(a.length, b.length);
  let max = 0;
  for (let i = 0; i < a.length; i += 3) max = Math.max(max, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]));
  return max;
}

/** 형상 오차와 그 합격선(ADR-0012: 1 mm와 Fusion 형상 대각선의 0.1% 중 큰 값) */
function shapeError(values: Record<string, number>, faces: SampleFace[]) {
  const shape = createMorph(spec, recording).shape(values);
  const expected = recordedPositions(shape, faces);
  const tolerance = shapeTolerance(
    diagonal(
      boundsOf((visit) => {
        for (let i = 0; i < expected.length; i += 3) visit(expected[i], expected[i + 1], expected[i + 2]);
      }),
    ),
  );
  return { error: maxDistance(shape.positions, expected), tolerance };
}

const bodiesOf = (shape: MorphShape) => [...new Set(shape.faces.map((f) => f.body))];

test("녹화본은 전체 폭을 세 위상 묶음(2·3·4칸)으로 나눴다", () => {
  assert.deepEqual(
    width.groups!.map((g) => g.counts.bays),
    [2, 4],
  );
});

test("샘플 값에서는 그 값이 든 위상 묶음의 녹화 형상과 일치한다", () => {
  const morph = createMorph(spec, recording);
  for (const sample of width.samples) {
    const shape = morph.shape({ shelf_w: sample.value });
    assert.ok(maxDistance(shape.positions, recordedPositions(shape, sample.faces)) < 1e-6, `shelf_w=${sample.value}`);
  }
});

test("검증점에서는 모든 위상 묶음에서 Fusion 형상과 형상 오차 합격선 안에서 맞는다", () => {
  for (const check of width.checks) {
    const { error, tolerance } = shapeError({ shelf_w: check.value }, check.faces);
    assert.ok(error <= tolerance, `shelf_w=${check.value}: 오차 ${error} mm > ${tolerance} mm`);
  }
});

test("위상 경계에서 칸막이가 페이드 없이 바로 나타난다", () => {
  const morph = createMorph(spec, recording);
  assert.deepEqual(bodiesOf(morph.shape({ shelf_w: 799.8 })), ["Carcass", "Divider"]);
  assert.deepEqual(bodiesOf(morph.shape({ shelf_w: 800.2 })), ["Carcass", "Divider", "Body1"]);
  assert.deepEqual(bodiesOf(morph.shape({ shelf_w: 1199.8 })), ["Carcass", "Divider", "Body1"]);
  assert.deepEqual(bodiesOf(morph.shape({ shelf_w: 1200.2 })), ["Carcass", "Divider", "Body1", "Body1 (2)"]);
  // 경계 바로 바깥의 형상은 경계에서 찾은 샘플 그대로다(사이 형상을 지어내지 않는다)
  for (const sample of width.samples.filter((s) => Math.abs(s.value - 800) < 0.2 || Math.abs(s.value - 1200) < 0.2)) {
    const shape = morph.shape({ shelf_w: sample.value });
    assert.ok(maxDistance(shape.positions, recordedPositions(shape, sample.faces)) < 1e-6, `shelf_w=${sample.value}`);
  }
});

test("같은 위상 묶음 안에서는 면과 연결이 그대로이고, 묶음이 바뀔 때만 달라진다", () => {
  const morph = createMorph(spec, recording);
  const [a, b, c] = [600, 700, 900].map((shelf_w) => morph.shape({ shelf_w }));
  assert.equal(a.triangles, b.triangles);
  assert.equal(a.faces, b.faces);
  assert.notEqual(a.triangles, c.triangles);
  // 기본 묶음은 Morph의 faces·triangles다
  assert.equal(c.triangles, morph.triangles);
});

test("두 슬라이더를 함께 움직이면 어느 위상 묶음에서든 교차 검증 샘플과 형상 오차 합격선 안에서 맞는다", () => {
  assert.deepEqual(
    shelfCrossChecks.map((s) => s.values.shelf_w),
    [600, 1000, 1300],
  );
  for (const sample of shelfCrossChecks) {
    assert.equal(sample.status, "ok");
    const { error, tolerance } = shapeError(sample.values, sample.faces);
    assert.ok(error <= tolerance, `${JSON.stringify(sample.values)}: 오차 ${error} mm > ${tolerance} mm`);
  }
});
