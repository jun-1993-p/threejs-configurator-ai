// 변형 엔진의 두께 선택(ADR-0010) 경계 테스트. 입력은 칸막이 선반 합성 녹화본과 두께 후보 형상, 정답은 녹화된 Fusion 형상이다.
// 판재 두께 t는 측판·상하판·칸막이에 같이 쓰이고, 전체 폭은 2·3·4칸 위상 묶음으로 나뉜다(solidcraft-test/shelf.sc).
import { test } from "node:test";
import assert from "node:assert/strict";

import { createMorph, faceKey, thicknessOptions, type MorphShape, type SampleFace } from "../src/engine.ts";
import { boundsOf, diagonal } from "../pipeline/measure.ts";
import { shapeTolerance } from "../pipeline/verify-numeric.ts";
import {
  drawerSpec,
  mixedThicknessRecording,
  mixedThicknessSamples,
  shelfRecording,
  shelfSpec,
  shelfThicknessChecks,
  shelfThicknessSamples,
  shelfThicknessSpec as spec,
} from "./recording.ts";

const data = { ...shelfRecording, thickness: shelfThicknessSamples };

function recordedPositions(shape: MorphShape, faces: SampleFace[]): number[] {
  const byKey = new Map(faces.map((f) => [faceKey(f), f]));
  assert.deepEqual(new Set(byKey.keys()), new Set(shape.faces.map(faceKey)), "면 구성이 녹화본과 다르다");
  return shape.faces.flatMap((f) => byKey.get(faceKey(f))!.points.flat());
}

function maxDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < a.length; i += 3) max = Math.max(max, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]));
  return max;
}

test("표준 두께 목록에서 기본 두께의 앞뒤 한 칸을 두께 후보로 고른다", () => {
  assert.deepEqual(thicknessOptions(12), [9, 12, 15]);
  assert.deepEqual(thicknessOptions(18), [15, 18, 24]);
  assert.deepEqual(thicknessOptions(3), [3, 6]);
  assert.deepEqual(thicknessOptions(30), [24, 30]);
  assert.deepEqual(thicknessOptions(21), []);
});

test("두께를 고르면 그 두께의 Fusion 형상으로 바뀐다(기본 묶음과 위상 묶음 모두)", () => {
  const morph = createMorph(spec, data);
  for (const sample of shelfThicknessSamples) {
    const shape = morph.shape(sample.values);
    assert.ok(maxDistance(shape.positions, recordedPositions(shape, sample.faces)) < 1e-6, JSON.stringify(sample.values));
  }
});

test("기본 두께에서는 두께 후보 형상이 없을 때와 같다", () => {
  const plain = createMorph(shelfSpec, shelfRecording);
  const morph = createMorph(spec, data);
  for (const shelf_w of [600, 900, 1300]) {
    assert.deepEqual(morph.positions({ shelf_w, t: 18 }), plain.positions({ shelf_w }));
  }
});

test("고른 두께는 다른 슬라이더와 덧셈으로 섞여 Fusion 형상과 형상 오차 합격선 안에서 맞는다", () => {
  const morph = createMorph(spec, data);
  for (const sample of shelfThicknessChecks) {
    assert.equal(sample.status, "ok");
    const shape = morph.shape(sample.values);
    const expected = recordedPositions(shape, sample.faces);
    const tolerance = shapeTolerance(
      diagonal(
        boundsOf((visit) => {
          for (let i = 0; i < expected.length; i += 3) visit(expected[i], expected[i + 1], expected[i + 2]);
        }),
      ),
    );
    const error = maxDistance(shape.positions, expected);
    assert.ok(error <= tolerance, `${JSON.stringify(sample.values)}: 오차 ${error} mm > ${tolerance} mm`);
  }
});

test("두께 후보 사이 값은 보간하지 않는다", () => {
  const morph = createMorph(spec, data);
  assert.throws(() => morph.shape({ t: 20 }), /두께 선택 t: 20 mm는 후보\(15·18·24\)가 아닙니다/);
});

test("두께 후보 형상이 없으면 엔진을 만들지 않는다", () => {
  const missing = { ...shelfRecording, thickness: shelfThicknessSamples.filter((s) => s.values.t !== 24) };
  assert.throws(() => createMorph(spec, missing), /두께 선택 t: 스윕 데이터에 t=24 형상이 없습니다/);
});

test("두께 선택 값은 묶인 파라미터 중 아무 이름으로 줘도 같다", () => {
  const twoBoards = { ...spec, thickness: [{ ...spec.thickness[0], ids: ["t_side", "t"] }] };
  const renamed = { ...data, thickness: shelfThicknessSamples.map((s) => ({ ...s, values: { t_side: s.values.t, ...s.values } })) };
  const morph = createMorph(twoBoards, renamed);
  assert.deepEqual(morph.positions({ t: 24 }), morph.positions({ t_side: 24 }));
  assert.notDeepEqual(morph.positions({ t: 24 }), morph.positions({}));
});

/** 서랍 폭 수식에 두께가 비율로 섞인 서랍장(drawer-mixed-t): 몸통 두께 t 선택과 전체 폭 슬라이더 */
const mixedSpec = { ...drawerSpec, thickness: [{ ids: ["t"], name: "몸통 두께", default: 18, options: [15, 18, 24] }] };
const isGrid = (s: { values: Record<string, number> }) => [400, 600, 800].includes(s.values.body_w);
const isMid = (s: { values: Record<string, number> }) => [500, 700].includes(s.values.body_w);
const mixedData = {
  ...mixedThicknessRecording,
  thickness: mixedThicknessSamples.filter((s) => s.values.body_w === undefined),
  grids: [{ parameters: ["t", "body_w"] as [string, string], samples: mixedThicknessSamples.filter(isGrid) }],
};

/** 녹화된 형상과 형상 오차 합격선 */
function expectedOf(shape: MorphShape, sample: { faces: SampleFace[] }) {
  const expected = recordedPositions(shape, sample.faces);
  const box = boundsOf((visit) => {
    for (let i = 0; i < expected.length; i += 3) visit(expected[i], expected[i + 1], expected[i + 2]);
  });
  return { expected, tolerance: shapeTolerance(diagonal(box)) };
}

test("두께 후보와 덧셈이 틀리는 슬라이더는 두께 격자 보강으로 마디 사이에서도 Fusion 형상과 형상 오차 합격선 안에서 맞는다", () => {
  const plain = createMorph(mixedSpec, { ...mixedData, grids: [] });
  const morph = createMorph(mixedSpec, mixedData);
  for (const sample of mixedThicknessSamples.filter(isMid)) {
    const shape = morph.shape(sample.values);
    const { expected, tolerance } = expectedOf(shape, sample);
    const error = maxDistance(shape.positions, expected);
    assert.ok(error <= tolerance, `${JSON.stringify(sample.values)}: 오차 ${error} mm > ${tolerance} mm`);
    // 격자 없이 덧셈만으로는 이 자리에서 합격선을 넘는다(녹화본이 시험하는 차이가 있다)
    assert.ok(maxDistance(plain.positions(sample.values), expected) > tolerance, JSON.stringify(sample.values));
  }
});

test("두께 격자 마디에서는 녹화 샘플과 일치하고, 기본 두께에서는 격자를 더하지 않는다", () => {
  const plain = createMorph(mixedSpec, { ...mixedData, grids: [] });
  const morph = createMorph(mixedSpec, mixedData);
  for (const sample of mixedThicknessSamples.filter(isGrid)) {
    const shape = morph.shape(sample.values);
    assert.ok(maxDistance(shape.positions, recordedPositions(shape, sample.faces)) < 1e-6, JSON.stringify(sample.values));
  }
  for (const body_w of [400, 550, 800]) assert.deepEqual(morph.positions({ body_w, t: 18 }), plain.positions({ body_w, t: 18 }));
});
