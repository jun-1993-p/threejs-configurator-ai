// 쇼핑몰에 내보낼 번들 안의 변형 엔진이 Node에서 직접 부른 엔진과 같은 꼭짓점을 내는지 본다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import { createMorph, type Spec, type SweepData } from "../src/engine.ts";
import { writeProduct } from "../scripts/build.ts";
import { UI_STYLES } from "../pipeline/ui-styles.ts";

const fixtures = new URL("../../fixtures/synthetic/", import.meta.url);
const recording: SweepData = JSON.parse(readFileSync(new URL("drawer.json", fixtures), "utf-8"));
const spec: Spec = JSON.parse(readFileSync(new URL("drawer.spec.json", fixtures), "utf-8"));

const out = mkdtempSync(join(tmpdir(), "configurator-"));
await writeProduct(spec, recording, out, UI_STYLES[0]);

test("결과물은 구성기 번들과 명세, 스윕 데이터, 스타일 선택, 붙여 넣을 div다", () => {
  assert.deepEqual(readdirSync(out).sort(), ["configurator.js", "index.html", "spec.json", "style.json", "sweeps.json"]);
  const html = readFileSync(join(out, "index.html"), "utf-8");
  assert.match(html, /<div data-configurator data-spec="spec\.json" data-sweeps="sweeps\.json" data-style="style\.json"><\/div>/);
  assert.match(html, /<script src="configurator\.js"><\/script>/);
});

test("번들 안의 엔진은 Node 엔진과 같은 꼭짓점을 낸다", () => {
  // 브라우저 전역 없이 번들을 실행한다. DOM이 없으면 자동 붙이기는 건너뛴다.
  const context = vm.createContext({});
  vm.runInContext(readFileSync(join(out, "configurator.js"), "utf-8"), context);
  const shipped = vm.runInContext("Configurator", context);
  const sweeps = JSON.parse(readFileSync(join(out, "sweeps.json"), "utf-8"));

  const local = createMorph(spec, recording);
  const bundled = shipped.createMorph(JSON.parse(readFileSync(join(out, "spec.json"), "utf-8")), sweeps);
  assert.deepEqual(Array.from(bundled.triangles), Array.from(local.triangles));
  for (const body_w of [400, 433.3, 600, 777, 800]) {
    assert.deepEqual(Array.from(bundled.positions({ body_w })), Array.from(local.positions({ body_w })), `body_w=${body_w}`);
  }
});

test("스윕 데이터에는 명세의 슬라이더가 쓰는 단독 스윕만 남는다", () => {
  const sweeps: SweepData = JSON.parse(readFileSync(join(out, "sweeps.json"), "utf-8"));
  assert.deepEqual(sweeps.sweeps.map((s) => s.parameter), ["body_w"]);
});

// 위상 묶음(ADR-0005): 칸막이 선반 합성 녹화본
const shelfRecording: SweepData = JSON.parse(readFileSync(new URL("shelf.json", fixtures), "utf-8"));
const shelfSpec: Spec = JSON.parse(readFileSync(new URL("shelf.spec.json", fixtures), "utf-8"));
const shelfOut = mkdtempSync(join(tmpdir(), "configurator-shelf-"));
await writeProduct(shelfSpec, shelfRecording, shelfOut, UI_STYLES[0]);

test("위상 묶음은 명세에 적히지 않고 스윕 데이터에 담기며, 묶음 안 단독 스윕도 명세의 슬라이더 것만 남는다", () => {
  const specText = readFileSync(join(shelfOut, "spec.json"), "utf-8");
  assert.doesNotMatch(specText, /groups|anchor|bays/);
  const sweeps: SweepData = JSON.parse(readFileSync(join(shelfOut, "sweeps.json"), "utf-8"));
  const width = sweeps.sweeps.find((s) => s.parameter === "shelf_w")!;
  assert.deepEqual(width.groups!.map((g) => g.counts.bays), [2, 4]);
  for (const group of width.groups!) assert.deepEqual(group.sweeps.map((s) => s.parameter), ["shelf_d"]);
  assert.equal(sweeps.sweeps.find((s) => s.parameter === "shelf_d")!.groups, undefined);
});

test("슬라이더 범위가 닿지 않는 위상 묶음은 스윕 데이터에서 뺀다", async () => {
  const narrow = { ...shelfSpec, sliders: [{ ...shelfSpec.sliders[0], max: 1100 }, shelfSpec.sliders[1]] };
  const dir = mkdtempSync(join(tmpdir(), "configurator-shelf-"));
  await writeProduct(narrow, shelfRecording, dir, UI_STYLES[0]);

  const sweeps: SweepData = JSON.parse(readFileSync(join(dir, "sweeps.json"), "utf-8"));
  assert.deepEqual(sweeps.sweeps.find((s) => s.parameter === "shelf_w")!.groups!.map((g) => g.counts.bays), [2]);
});

test("번들 안의 엔진은 위상 묶음을 넘나들어도 Node 엔진과 같은 형상을 낸다", () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(join(shelfOut, "configurator.js"), "utf-8"), context);
  const shipped = vm.runInContext("Configurator", context);
  const bundled = shipped.createMorph(shelfSpec, JSON.parse(readFileSync(join(shelfOut, "sweeps.json"), "utf-8")));
  const local = createMorph(shelfSpec, shelfRecording);
  for (const values of [{ shelf_w: 600 }, { shelf_w: 1000, shelf_d: 250 }, { shelf_w: 1300, shelf_d: 350 }] as Record<string, number>[]) {
    const [a, b] = [bundled.shape(values), local.shape(values)];
    assert.deepEqual(Array.from(a.triangles), Array.from(b.triangles), JSON.stringify(values));
    assert.deepEqual(Array.from(a.positions), Array.from(b.positions), JSON.stringify(values));
  }
});
