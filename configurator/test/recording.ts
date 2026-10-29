// 시험 도우미: 서랍장 합성 녹화본과 교차 검증 샘플, 검증점 형상을 조금 바꾼 사본을 만든다. 시험 파일이 아니다.
import { readFileSync } from "node:fs";

import type { Spec } from "../src/engine.ts";
import type { UploadBundle } from "../pipeline/upload-bundle.ts";
import type { CrossSample } from "../pipeline/verify-cross.ts";

const fixtures = new URL("../../fixtures/synthetic/", import.meta.url);
export const recording: UploadBundle = JSON.parse(readFileSync(new URL("drawer.json", fixtures), "utf-8"));
export const drawerSpec: Spec = JSON.parse(readFileSync(new URL("drawer.spec.json", fixtures), "utf-8"));

export const AXIS = { X: 0, Y: 1, Z: 2 } as const;

type Check = UploadBundle["sweeps"][number]["checks"][number];

/** body_w 검증점 하나의 형상을 바꾼 녹화본 사본 */
export function withCheck(value: number, change: (check: Check) => void): UploadBundle {
  const bundle = structuredClone(recording);
  const check = bundle.sweeps.find((s) => s.parameter === "body_w")!.checks.find((c) => c.value === value)!;
  change(check);
  return bundle;
}

/** 부품의 면 이름 목록 */
export const facesOf = (part: string) =>
  new Set(recording.parts.find((p) => p.name === part)!.faces.map((i) => recording.baseline.faces[i].name));

/** body_w 검증점에서 부품의 한 축 가장 큰 좌표에 있는 점들을 delta만큼 민다(그 축 치수가 delta만큼 늘어난다) */
export function pushMaxSide(value: number, part: string, axis: keyof typeof AXIS, delta: number): UploadBundle {
  const names = facesOf(part);
  const c = AXIS[axis];
  return withCheck(value, (check) => {
    const faces = check.faces.filter((f) => names.has(f.name));
    const max = Math.max(...faces.flatMap((f) => f.points.map((p) => p[c])));
    for (const f of faces) for (const p of f.points) if (Math.abs(p[c] - max) < 1e-6) p[c] += delta;
  });
}

/** 깊이 축 슬라이더가 둘인 명세: 전체 깊이(몸통·서랍)와 서랍 깊이(서랍만) */
export const depthSpec: Spec = {
  ...drawerSpec,
  sliders: [
    {
      ...drawerSpec.sliders[0],
      id: "body_d",
      name: "전체 깊이",
      axis: "D",
      min: 300, max: 600, default: 450,
      source: "치수규칙/서랍장/깊이",
      affects: { shape: ["Carcass", "DrawerBox"], move: [] },
    },
    {
      ...drawerSpec.sliders[0],
      id: "drawer_d",
      name: "서랍 깊이",
      axis: "D",
      min: 300, max: 600, default: 430,
      source: "치수규칙/서랍장/서랍_깊이",
      affects: { shape: ["DrawerBox"], move: [] },
    },
  ],
};

/** 한 스윕의 샘플·검증점마다 부품을 축 방향으로 (값 - base) × rate만큼 옮긴 녹화본 사본(자리만 옮겨지는 부품). base는 기본 형상의 값이다. */
export function movePart(parameter: string, base: number, part: string, axis: keyof typeof AXIS, rate: number): UploadBundle {
  const bundle = structuredClone(recording);
  const names = facesOf(part);
  const sweep = bundle.sweeps.find((s) => s.parameter === parameter)!;
  for (const shape of [...sweep.samples, ...sweep.checks]) {
    for (const f of shape.faces) if (names.has(f.name)) for (const p of f.points) p[AXIS[axis]] += (shape.value - base) * rate;
  }
  return bundle;
}

/** 서랍장 교차 검증 샘플 합성 녹화본(전체 폭 × 전체 높이). synthetic/make_cross_checks.py로 만든다. */
export const crossChecks: CrossSample[] = JSON.parse(readFileSync(new URL("drawer.cross-checks.json", fixtures), "utf-8")).samples;

/** 서로 영향이 없는 두 슬라이더: 전체 폭(몸통·서랍의 X)과 전체 높이(몸통의 Z) */
export const widthHeightSpec: Spec = {
  ...drawerSpec,
  sliders: [
    drawerSpec.sliders[0],
    {
      ...drawerSpec.sliders[0],
      id: "body_h",
      name: "전체 높이",
      axis: "H",
      min: 500, max: 1000, default: 700,
      source: "치수규칙/서랍장/높이",
      affects: { shape: ["Carcass"], move: [] },
    },
  ],
};

/** widthHeightSpec 범위의 모서리 조합 4개(전체 폭 400·800 × 전체 높이 500·1000)에서 녹화한 교차 검증 샘플 */
export const crossCorners: CrossSample[] = JSON.parse(readFileSync(new URL("drawer.cross-corners.json", fixtures), "utf-8")).samples;

/** depthSpec 범위의 모서리 조합 4개(전체 깊이 300·600 × 서랍 깊이 300·600). 서랍 깊이는 Fusion 수식으로 전체 깊이를 따른다. */
export const crossDepth: CrossSample[] = JSON.parse(readFileSync(new URL("drawer.cross-depth.json", fixtures), "utf-8")).samples;
