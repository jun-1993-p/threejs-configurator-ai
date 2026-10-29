// 시험 도우미: 서랍장 합성 녹화본과, 검증점 형상을 조금 바꾼 사본을 만든다. 시험 파일이 아니다.
import { readFileSync } from "node:fs";

import type { Spec } from "../src/engine.ts";
import type { UploadBundle } from "../pipeline/upload-bundle.ts";

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
