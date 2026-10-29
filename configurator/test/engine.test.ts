// 변형 엔진 경계 테스트. 입력은 서랍장 합성 녹화본, 정답은 녹화된 형상이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createMorph, type Morph, type SampleFace, type Spec, type SweepData } from "../src/engine.ts";
import { boundsOf, diagonal } from "../pipeline/measure.ts";
import { shapeTolerance } from "../pipeline/verify-numeric.ts";
import { crossChecks, widthHeightSpec } from "./recording.ts";

const fixtures = new URL("../../fixtures/synthetic/", import.meta.url);
const recording: SweepData = JSON.parse(readFileSync(new URL("drawer.json", fixtures), "utf-8"));
const spec: Spec = JSON.parse(readFileSync(new URL("drawer.spec.json", fixtures), "utf-8"));

/** 녹화된 면 점을 엔진 면 순서대로 이어 붙인다. 면은 (바디, 이름)으로 짝짓는다. */
function recordedPositions(morph: Morph, faces: SampleFace[]): number[] {
  const byName = new Map(faces.map((f) => [`${f.body}/${f.name}`, f]));
  return morph.faces.flatMap((f) => byName.get(`${f.body}/${f.name}`)!.points.flat());
}

function maxDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  assert.equal(a.length, b.length);
  let max = 0;
  for (let i = 0; i < a.length; i += 3) {
    max = Math.max(max, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]));
  }
  return max;
}

test("샘플 값에서는 녹화된 형상과 일치한다", () => {
  const morph = createMorph(spec, recording);
  const sweep = recording.sweeps.find((s) => s.parameter === "body_w")!;
  for (const sample of sweep.samples) {
    const got = morph.positions({ body_w: sample.value });
    assert.ok(maxDistance(got, recordedPositions(morph, sample.faces)) < 1e-9, `body_w=${sample.value}`);
  }
});

/** 부품별 [최솟값, 최댓값] 축별 범위 */
function partBounds(morph: Morph, positions: Float64Array, part: string) {
  const bounds = [0, 1, 2].map(() => [Infinity, -Infinity]);
  for (const f of morph.faces.filter((f) => f.part === part)) {
    for (let i = f.start; i < f.start + f.count; i++) {
      for (let c = 0; c < 3; c++) {
        bounds[c][0] = Math.min(bounds[c][0], positions[i * 3 + c]);
        bounds[c][1] = Math.max(bounds[c][1], positions[i * 3 + c]);
      }
    }
  }
  return bounds.map(([lo, hi]) => [Number(lo.toFixed(6)), Number(hi.toFixed(6))]);
}

test("샘플 사이 값에서는 폭만 그 값으로 바뀐다", () => {
  // 서랍장 모델: 몸통 폭 = body_w(가운데 0), 서랍 폭 = body_w - 40, 깊이·높이는 body_w와 무관
  const morph = createMorph(spec, recording);
  const positions = morph.positions({ body_w: 525 });
  assert.deepEqual(partBounds(morph, positions, "Carcass"), [[-262.5, 262.5], [0, 450], [0, 700]]);
  assert.deepEqual(partBounds(morph, positions, "DrawerBox"), [[-242.5, 242.5], [0, 430], [20, 220]]);
});

test("값을 주지 않은 슬라이더는 명세의 default를 쓴다", () => {
  const morph = createMorph(spec, recording);
  assert.deepEqual(partBounds(morph, morph.positions({}), "Carcass"), [[-300, 300], [0, 450], [0, 700]]);
});

test("슬라이더 하나만 움직이면 단독 스윕 보간과 결과가 같다", () => {
  for (const slider of widthHeightSpec.sliders) {
    const single = createMorph({ ...widthHeightSpec, sliders: [slider] }, recording);
    const multi = createMorph(widthHeightSpec, recording);
    for (const value of [slider.min, (slider.min + slider.default) / 2 + 1, slider.max - 23]) {
      assert.deepEqual(multi.positions({ [slider.id]: value }), single.positions({ [slider.id]: value }), `${slider.id}=${value}`);
    }
  }
});

test("두 슬라이더를 함께 움직이면 이동량을 더한 결과가 교차 검증 샘플과 형상 오차 합격선 안에서 맞는다", () => {
  const morph = createMorph(widthHeightSpec, recording);
  assert.ok(crossChecks.length >= 2);
  for (const sample of crossChecks) {
    assert.equal(sample.status, "ok");
    // 고객이 고를 수 있는 값이어야 한다
    for (const slider of widthHeightSpec.sliders) {
      const value = sample.values[slider.id];
      assert.ok(slider.min <= value && value <= slider.max, `${slider.id}=${value}가 슬라이더 범위 밖`);
    }
    const expected = recordedPositions(morph, sample.faces);
    // 형상 오차 합격선(ADR-0012): 1 mm와 Fusion 형상 대각선의 0.1% 중 큰 값
    const tolerance = shapeTolerance(
      diagonal(
        boundsOf((visit) => {
          for (let i = 0; i < expected.length; i += 3) visit(expected[i], expected[i + 1], expected[i + 2]);
        }),
      ),
    );
    const error = maxDistance(morph.positions(sample.values), expected);
    assert.ok(error <= tolerance, `${JSON.stringify(sample.values)}: 오차 ${error} mm > ${tolerance} mm`);
  }
});
