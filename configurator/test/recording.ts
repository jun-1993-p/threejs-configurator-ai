// 시험 도우미: 서랍장 합성 녹화본과 교차 검증 샘플, 검증점 형상을 조금 바꾼 사본을 만든다. 시험 파일이 아니다.
import { readFileSync } from "node:fs";

import type { Spec } from "../src/engine.ts";
import type { UploadBundle } from "../pipeline/upload-bundle.ts";
import type { CrossSample } from "../pipeline/verify-cross.ts";

const fixtures = new URL("../../fixtures/synthetic/", import.meta.url);
export const recording: UploadBundle = JSON.parse(readFileSync(new URL("drawer.json", fixtures), "utf-8"));
export const drawerSpec: Spec = JSON.parse(readFileSync(new URL("drawer.spec.json", fixtures), "utf-8"));

/**
 * 서랍 속 비우기 면 지정점이 처음 모델의 (0, 215, 220)인 서랍장 합성 녹화본(solidcraft-test/drawer-shell-point.sc).
 * 서랍 깊이가 215 아래면 면 하나가 사라지므로, 애드인이 전체 깊이와 서랍 깊이의 min 쪽 범위를 모델링 오류 의심으로 줄였다.
 */
export const shellPointRecording: UploadBundle = JSON.parse(readFileSync(new URL("drawer-shell-point.json", fixtures), "utf-8"));

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

/**
 * body_w 검증점에서 부품의 한 축 가장 큰 쪽 판을 통째로 delta만큼 민다(그 축 치수가 delta만큼 늘고 판 두께는 그대로다).
 * 판은 가장 큰 좌표에서 30 mm(표준 두께 목록의 최댓값) 안의 점들이다.
 */
export function pushMaxSide(value: number, part: string, axis: keyof typeof AXIS, delta: number): UploadBundle {
  const names = facesOf(part);
  const c = AXIS[axis];
  return withCheck(value, (check) => {
    const faces = check.faces.filter((f) => names.has(f.name));
    const max = Math.max(...faces.flatMap((f) => f.points.map((p) => p[c])));
    for (const f of faces) for (const p of f.points) if (p[c] > max - 30) p[c] += delta;
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

/** depthSpec 범위의 3×3 격자(전체 깊이 300·450·600 × 서랍 깊이 300·430·600)에서 녹화한 격자 보강 샘플 */
export const gridDepth: CrossSample[] = JSON.parse(readFileSync(new URL("drawer.grid-depth.json", fixtures), "utf-8")).samples;

/** 격자 검증점 8곳(격자 칸 가운데 4곳, 기본값 줄 위 마디 사이 4곳)의 Fusion 형상. 격자 보간을 재는 정답이다. */
export const gridDepthChecks: CrossSample[] = JSON.parse(readFileSync(new URL("drawer.grid-depth-checks.json", fixtures), "utf-8")).samples;

/** 서로 영향이 없는 세 슬라이더: 전체 폭·전체 높이·전체 깊이 */
export const threeSpec: Spec = { ...widthHeightSpec, sliders: [...widthHeightSpec.sliders, depthSpec.sliders[0]] };

/**
 * 칸막이 선반 합성 녹화본(solidcraft-test/shelf.sc). 칸 수 bays = floor(전체 폭 / 400) + 1이라 전체 폭 800·1200에서
 * 칸막이 바디가 하나씩 늘어나고, 애드인이 전체 폭 스윕을 위상 묶음 셋(2·3·4칸)으로 나눴다.
 */
export const shelfRecording: UploadBundle = JSON.parse(readFileSync(new URL("shelf.json", fixtures), "utf-8"));
export const shelfSpec: Spec = JSON.parse(readFileSync(new URL("shelf.spec.json", fixtures), "utf-8"));

/** 칸막이 선반 전체 폭 × 전체 깊이 교차 검증 샘플. 2칸(600, 250)·3칸(1000, 350)·4칸(1300, 350) 묶음에 하나씩이다. */
export const shelfCrossChecks: CrossSample[] = JSON.parse(readFileSync(new URL("shelf.cross-checks.json", fixtures), "utf-8")).samples;

/** threeSpec의 세 쌍 모서리 조합 12개에서 녹화한 교차 검증 샘플 */
export const crossThree: CrossSample[] = JSON.parse(readFileSync(new URL("drawer.cross-three.json", fixtures), "utf-8")).samples;

/** 칸막이 선반 명세(shelfSpec) 범위의 모서리 조합 4개(전체 폭 500·1300 × 전체 깊이 200·400). 2칸·4칸 묶음에 걸친다. */
export const shelfCrossCorners: CrossSample[] = JSON.parse(readFileSync(new URL("shelf.cross-corners.json", fixtures), "utf-8")).samples;

/** 칸막이 선반 판재 두께 t(기본 18)를 두께 선택으로 노출한 명세 */
export const shelfThicknessSpec: Spec = {
  ...shelfSpec,
  thickness: [{ ids: ["t"], name: "판재 두께", default: 18, options: [15, 18, 24] }],
};

/** 두께 후보 형상: t=15·24를 기본 형상과 2칸(전체 폭 675)·4칸(1200.04) 위상 묶음의 기준 값에서 뽑았다 */
export const shelfThicknessSamples: CrossSample[] = JSON.parse(readFileSync(new URL("shelf.thickness.json", fixtures), "utf-8")).samples;

/** 두께와 슬라이더를 함께 바꾼 Fusion 형상(t=15·전체 폭 1000, t=24·전체 폭 600·1300, t=24·전체 깊이 400). 덧셈을 재는 정답이다. */
export const shelfThicknessChecks: CrossSample[] = JSON.parse(readFileSync(new URL("shelf.thickness-checks.json", fixtures), "utf-8")).samples;

/** 칸막이 선반 두께 후보 15·24마다 전체 폭(500·1300)과 전체 깊이(200·400) 범위 끝에서 녹화한 두께 교차 검증 샘플 */
export const shelfThicknessCross: CrossSample[] = JSON.parse(readFileSync(new URL("shelf.thickness-cross.json", fixtures), "utf-8")).samples;

/**
 * 몸통 셸 두께가 전체 폭의 비율(body_w × 0.03)인 서랍장 합성 녹화본(solidcraft-test/drawer-ratio-t.sc).
 * 기본 형상에서는 18 mm이지만 전체 폭을 움직이면 몸통 판재 두께가 따라 바뀐다(두께 고정 위반).
 */
export const ratioThicknessRecording: UploadBundle = JSON.parse(readFileSync(new URL("drawer-ratio-t.json", fixtures), "utf-8"));

/**
 * 몸통 두께가 사용자 파라미터 t(18 mm)이고, 서랍 폭 수식에 두께가 비율로 섞인 서랍장 합성 녹화본(solidcraft-test/drawer-mixed-t.sc).
 * 서랍 폭 = body_w - 40 + (body_w - 600) × (t - 18) / 60이라, 기본 두께에서는 덧셈이 맞고 다른 두께 후보에서는 전체 폭과 덧셈이 맞지 않는다.
 */
export const mixedThicknessRecording: UploadBundle = JSON.parse(readFileSync(new URL("drawer-mixed-t.json", fixtures), "utf-8"));

/**
 * drawer-mixed-t의 추가 샘플: 두께 후보 형상(t=15·24), 두께 교차 검증(전체 폭 400·800), 격자 보강(전체 폭 400·600·800),
 * 격자 검증점(전체 폭 500·700). 두께는 모두 15·24다.
 */
export const mixedThicknessSamples: CrossSample[] = JSON.parse(readFileSync(new URL("drawer-mixed-t.samples.json", fixtures), "utf-8")).samples;
