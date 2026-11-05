// 실제 녹화본으로 검증 단계를 돌리는 도구(scripts/verify-recording.ts). 녹화본과 명세는 합성 녹화본 파일이고,
// Fusion 연결 자리에는 녹화한 추가 샘플로 답하거나 끊겨 있는 가짜 포트를 넣는다. 찍은 줄로 결과를 본다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FUSION_NEEDED, type FusionPort } from "../pipeline/runner.ts";
import type { SampleRequest } from "../pipeline/verify-spec.ts";
import type { CrossSample } from "../pipeline/verify-cross.ts";
import { main } from "../scripts/verify-recording.ts";
import {
  crossCorners,
  crossDepth,
  depthSpec,
  drawerSpec,
  gridDepth,
  gridDepthChecks,
  ratioThicknessRecording,
  recording,
  shelfCrossCorners,
  shelfRecording,
  shelfThicknessCross,
  shelfThicknessSamples,
  shelfThicknessSpec,
  widthHeightSpec,
} from "./recording.ts";

const fixtures = new URL("../../fixtures/synthetic/", import.meta.url);
const drawerPath = fileURLToPath(new URL("drawer.json", fixtures));

/** 녹화한 추가 샘플로 답하는 Fusion 연결. 받은 요청을 남긴다. */
function recordedFusion(samples: CrossSample[]) {
  const requests: SampleRequest[] = [];
  const port: FusionPort = {
    requestSamples: async (request) => {
      requests.push(request);
      const answered = request.values.map((values) => samples.find((s) => JSON.stringify(s.values) === JSON.stringify(values)));
      if (answered.includes(undefined)) throw new Error(`녹화하지 않은 값 묶음: ${JSON.stringify(request.values)}`);
      return { status: "answered", response: { samples: answered } };
    },
    reconnected: () => Promise.reject(new Error("도구는 다시 연결되기를 기다리지 않는다")),
  };
  return { port, requests };
}

const disconnected: FusionPort = {
  requestSamples: () => Promise.resolve({ status: "disconnected" }),
  reconnected: () => Promise.reject(new Error("도구는 다시 연결되기를 기다리지 않는다")),
};

/** 임시 폴더에 명세·녹화본을 쓰고, 도구를 돌려 찍은 줄과 끝 코드를 돌려준다 */
async function runTool(args: (dir: string) => string[], fusion: FusionPort, files: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "verify-recording-"));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
  const lines: string[] = [];
  const uploads: string[] = [];
  const code = await main(args(dir), {
    fusion: (upload) => {
      uploads.push(upload);
      return fusion;
    },
    print: (line) => lines.push(line),
    servingFile: join(dir, "serving.json"),
  });
  return { code, lines, uploads, dir };
}

test("명세의 검증 단계를 모두 돌려 단계마다 통과를 찍고, 교차 검증 샘플은 업로드한 애드인에 요청한다", async () => {
  const fusion = recordedFusion(crossCorners);
  const { code, lines, uploads } = await runTool((dir) => [drawerPath, join(dir, "spec.json"), "--upload", "u1"], fusion.port, { "spec.json": widthHeightSpec });

  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(uploads, ["u1"]);
  assert.deepEqual(fusion.requests.map((r) => r.kind), ["cross"]);
  for (const stage of ["스윕 범위", "두께 고정 실측", "수치 검증", "축 반응", "교차 검증"]) assert.ok(lines.includes(`[${stage}] 통과`), lines.join("\n"));
});

test("두께 선택이 있는 명세는 두께 후보 형상부터 애드인에 받아 그 단계도 찍는다", async () => {
  const fusion = recordedFusion([...shelfThicknessSamples, ...shelfCrossCorners, ...shelfThicknessCross]);
  const { lines } = await runTool((dir) => [join(dir, "shelf.json"), join(dir, "spec.json"), "--upload", "u1"], fusion.port, {
    "shelf.json": shelfRecording,
    "spec.json": shelfThicknessSpec,
  });

  assert.equal(fusion.requests[0].kind, "thickness");
  assert.equal(lines[0], "[두께 후보 형상] 통과", lines.join("\n"));
});

test("애드인이 교차 검증 샘플을 뽑지 못하면 그 까닭을 찍고 끝나며, 앞 단계 결과는 이미 찍혀 있다", async () => {
  const failing: FusionPort = {
    requestSamples: () => Promise.resolve({ status: "failed", reason: "재계산 실패" }),
    reconnected: () => Promise.reject(new Error("도구는 다시 연결되기를 기다리지 않는다")),
  };
  const { code, lines } = await runTool((dir) => [drawerPath, join(dir, "spec.json"), "--upload", "u1"], failing, { "spec.json": widthHeightSpec });

  assert.equal(code, 1);
  assert.deepEqual(lines, [
    "[스윕 범위] 통과",
    "[두께 고정 실측] 통과",
    "[수치 검증] 통과",
    "[축 반응] 통과",
    "애드인이 추가 샘플을 뽑지 못했습니다: 재계산 실패",
  ]);
});

test("첫 실패 단계에서 멈추지 않고 뒤 단계까지 보며, 피드백마다 슬라이더·부품·종류·잰 값을 한 줄로 찍는다", async () => {
  const { code, lines } = await runTool((dir) => [join(dir, "ratio.json"), join(dir, "spec.json"), "--upload", "u1"], recordedFusion([]).port, {
    "ratio.json": ratioThicknessRecording,
    "spec.json": drawerSpec,
  });

  assert.equal(code, 1);
  const failure = lines.find((l) => l.startsWith("[두께 고정 실측] "))!;
  assert.match(failure, /^\[두께 고정 실측\] 슬라이더 body_w · 부품 Carcass · thickness_change · 잰 값 \{.*"baseline_mm":18/);
  // 두께 고정 실측 뒤 단계도 찍는다
  assert.ok(lines.some((l) => l.startsWith("[수치 검증] ")), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("[축 반응] ")), lines.join("\n"));
});

test("교차 검증에 실패한 쌍은 바로 격자로 보강해 같은 명세를 다시 검증하고, 그 회차를 따로 찍는다", async () => {
  const fusion = recordedFusion([...crossDepth, ...gridDepth, ...gridDepthChecks]);
  const { code, lines } = await runTool((dir) => [drawerPath, join(dir, "spec.json"), "--upload", "u1"], fusion.port, { "spec.json": depthSpec });

  assert.deepEqual(fusion.requests.map((r) => r.kind), ["cross", "grid"]);
  assert.ok(lines.some((l) => /^\[교차 검증\] 슬라이더 /.test(l)), lines.join("\n"));
  assert.ok(lines.includes("[격자 보강 뒤 교차 검증] 통과"), lines.join("\n"));
  assert.ok(lines.includes("[격자 보강 뒤 격자 검증점] 통과"), lines.join("\n"));
  assert.equal(code, 0);
});

test("애드인이 연결되지 않았으면 기다리지 않고 Fusion 연결 필요와 애드인 상태 파일을 찍고 끝낸다", async () => {
  const serving = { upload: null, main_thread_at: "2026-11-05T10:00:00Z", server_seen_at: null, error: "모달 창" };
  const { code, lines } = await runTool((dir) => [drawerPath, join(dir, "spec.json"), "--upload", "u1"], disconnected, {
    "spec.json": widthHeightSpec,
    "serving.json": serving,
  });

  assert.equal(code, 3);
  assert.ok(lines.includes(FUSION_NEEDED), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes('"error":"모달 창"')), lines.join("\n"));
});

test("애드인 상태 파일이 없으면 Fusion 연결 필요만 알린다", async () => {
  const { code, lines } = await runTool((dir) => [drawerPath, join(dir, "spec.json"), "--upload", "u1"], disconnected, { "spec.json": widthHeightSpec });

  assert.equal(code, 3);
  assert.equal(lines.at(-1), FUSION_NEEDED);
});

test("--responses는 명세 없이 녹화본만으로 슬라이더별 부품 반응을 축별로 찍는다", async () => {
  const { code, lines, uploads } = await runTool(() => [drawerPath, "--responses"], disconnected);

  assert.equal(code, 0);
  assert.deepEqual(uploads, []);
  // 전체 폭 스윕은 300~900이고 기본값이 600이라, 몸통의 X 치수가 가장 크게 300 mm 바뀌고 자리는 그대로다
  const width = lines.indexOf("body_w: 전체 치수 X 300");
  assert.ok(width >= 0, lines.join("\n"));
  assert.equal(lines[width + 1], "  Carcass: 치수 X 300 / 위치 -");
  // 서랍 깊이만 서랍을 움직이고 몸통은 그대로라 몸통 줄이 없다
  const drawer = lines.findIndex((l) => l.startsWith("drawer_d: "));
  assert.match(lines[drawer + 1], /^ {2}DrawerBox: 치수 Y [\d.]+ \/ 위치 Y [\d.]+$/);
  assert.ok(!lines[drawer + 2].startsWith("  Carcass"), lines.join("\n"));
});

test("--responses는 업로드 스윕 문제(보간 실패, 부피 튐)도 찍는다", async () => {
  const quiet = await runTool(() => [drawerPath, "--responses"], disconnected);
  assert.ok(quiet.lines.includes("[업로드 스윕] 통과"), quiet.lines.join("\n"));

  // 서랍장 몸통의 폭 600 샘플 부피를 1.5배로 튀게 한다(verify-sweep.test.ts와 같은 변형)
  const bundle = structuredClone(recording);
  const sample = bundle.sweeps.find((s) => s.parameter === "body_w")!.samples.find((s) => s.value === 600)!;
  sample.bodies!.find((b) => b.name === "Carcass")!.volume *= 1.5;
  const { code, lines } = await runTool((dir) => [join(dir, "rec.json"), "--responses"], disconnected, { "rec.json": bundle });

  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.startsWith("[업로드 스윕] 슬라이더 body_w · 부품 Carcass · volume_jump")), lines.join("\n"));
});

test("명세가 녹화본을 가리키지 않으면 검증하지 않고 그 오류를 찍는다", async () => {
  const wrong = { ...widthHeightSpec, sliders: [{ ...widthHeightSpec.sliders[0], id: "없는_파라미터" }, widthHeightSpec.sliders[1]] };
  const { code, lines } = await runTool((dir) => [drawerPath, join(dir, "spec.json"), "--upload", "u1"], disconnected, { "spec.json": wrong });

  assert.equal(code, 2);
  assert.ok(lines.some((l) => l.includes("없는_파라미터")), lines.join("\n"));
});
