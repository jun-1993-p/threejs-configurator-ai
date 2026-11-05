// 슬라이더 범위를 스윕 범위 안의 어디로 좁혀도 조립과 엔진이 멈추지 않는지 합성 녹화본으로 본다.
// 범위 끝은 샘플 값 사이와 위상 묶음 경계 양쪽에 둔다. 위상 묶음을 모두 비켜 가는 범위에서 엔진이 "기준 형상과 면 구성이
// 다릅니다"로 멈춘 결함은 Fusion 업로드에서야 드러났다(티켓 26). 합성 녹화본으로도 재현됐으므로 여기서 미리 잡는다.
// 그 결함을 잡는 쪽은 위상 묶음이 있는 선반이다. 서랍장은 묶음이 없어 범위를 좁혀도 멈추지 않는지만 본다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createMorph, reaches, type Slider, type Spec, type SweepData } from "../src/engine.ts";
import { sweepDataFor } from "../pipeline/assemble.ts";

const fixtures = new URL("../../fixtures/synthetic/", import.meta.url);
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, fixtures), "utf-8"));

/** 기본값을 품는 범위 후보: 아래 끝은 스윕 min과 기본값 아래 칸 사이들, 위 끝은 기본값 위 칸 사이들과 스윕 max */
function ranges(recording: SweepData, id: string, value: number): [number, number][] {
  const sweep = recording.sweeps.find((s) => s.parameter === id)!;
  const edges = [...sweep.samples.map((s) => s.value), ...(sweep.groups ?? []).flatMap((g) => [g.range.min, g.range.max])];
  const points = [...new Set(edges)].sort((a, b) => a - b);
  const between = points.slice(1).map((p, i) => (p + points[i]) / 2);
  const lows = [points[0], ...between.filter((v) => v < value)];
  const highs = [...between.filter((v) => v > value), points[points.length - 1]];
  return lows.flatMap((lo) => highs.map((hi): [number, number] => [lo, hi]));
}

/** 범위마다 엔진이 범위 끝과 기본값의 형상을 내는지 보고, 위상 묶음에 닿는 개수별로 몇 번 돌았는지 돌려준다 */
function narrowEverySlider(recording: SweepData, spec: Spec): Map<string, number> {
  const reachedGroups = new Map<string, number>();
  spec.sliders.forEach((slider, i) => {
    const groups = recording.sweeps.find((s) => s.parameter === slider.id)?.groups ?? [];
    for (const [min, max] of ranges(recording, slider.id, slider.default)) {
      const narrowed: Slider = { ...slider, min, max };
      const narrow: Spec = { ...spec, sliders: spec.sliders.map((s, j) => (j === i ? narrowed : s)) };
      const place = `${slider.id} ${min}~${max}`;
      let morph;
      try {
        morph = createMorph(narrow, sweepDataFor(narrow, recording));
      } catch (error) {
        throw new Error(`${place}: 엔진을 만들지 못했습니다`, { cause: error });
      }
      for (const value of [min, slider.default, max]) {
        assert.ok(Array.from(morph.shape({ [slider.id]: value }).positions).every(Number.isFinite), `${place}: ${slider.id}=${value}`);
      }
      const key = groups.length === 0 ? "묶음 없음" : `묶음 ${groups.filter((g) => reaches(narrowed, g)).length}/${groups.length}`;
      reachedGroups.set(key, (reachedGroups.get(key) ?? 0) + 1);
    }
  });
  return reachedGroups;
}

test("선반: 폭 범위가 위상 묶음을 모두 비켜 가도, 일부만 닿아도, 모두 닿아도 엔진이 형상을 낸다", () => {
  const tried = narrowEverySlider(read<SweepData>("shelf.json"), read<Spec>("shelf.spec.json"));
  // 선반 폭에는 위상 묶음이 둘(2칸, 4칸) 있다. 세 경우가 모두 실제로 시도돼야 이 시험이 결함을 덮는다.
  for (const key of ["묶음 0/2", "묶음 1/2", "묶음 2/2"]) assert.ok((tried.get(key) ?? 0) > 0, `${key} 범위를 시도하지 않았다`);
});

test("서랍장: 위상 묶음이 없는 녹화본도 범위를 어디로 좁혀도 엔진이 형상을 낸다", () => {
  const tried = narrowEverySlider(read<SweepData>("drawer.json"), read<Spec>("drawer.spec.json"));
  assert.ok((tried.get("묶음 없음") ?? 0) > 1);
});
