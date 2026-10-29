// 쇼핑몰에 내보낼 번들 안의 변형 엔진이 Node에서 직접 부른 엔진과 같은 꼭짓점을 내는지 본다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import { createMorph, type Spec, type SweepData } from "../src/engine.ts";
import { writeProduct } from "../scripts/build.ts";

const fixtures = new URL("../../fixtures/synthetic/", import.meta.url);
const recording: SweepData = JSON.parse(readFileSync(new URL("drawer.json", fixtures), "utf-8"));
const spec: Spec = JSON.parse(readFileSync(new URL("drawer.spec.json", fixtures), "utf-8"));

const out = mkdtempSync(join(tmpdir(), "configurator-"));
await writeProduct(spec, recording, out);

test("결과물은 구성기 번들과 명세, 스윕 데이터, 붙여 넣을 div다", () => {
  assert.deepEqual(readdirSync(out).sort(), ["configurator.js", "index.html", "spec.json", "sweeps.json"]);
  const html = readFileSync(join(out, "index.html"), "utf-8");
  assert.match(html, /<div data-configurator data-spec="spec\.json" data-sweeps="sweeps\.json"><\/div>/);
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
