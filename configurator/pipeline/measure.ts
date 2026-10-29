// 검증기들이 같이 쓰는 측정 도우미: 명세의 W·D·H와 Fusion 축의 대응, 바운딩 박스, 보고용 반올림.
import type { Axis, Spec } from "../src/engine.ts";

export const DIMENSIONS: Axis[] = ["W", "D", "H"];

const AXIS_INDEX = { X: 0, Y: 1, Z: 2 } as const;

/** 명세의 W·D·H가 대응하는 Fusion 좌표 번호(x 0, y 1, z 2) */
export const coordinateOf = (axes: Spec["axes"], dimension: Axis) => AXIS_INDEX[axes[dimension] as keyof typeof AXIS_INDEX];

/** 보고하는 mm 값의 자릿수. 부동소수 끝자리가 피드백에 섞이지 않게 한다. */
export const round = (mm: number) => Math.round(mm * 1e4) / 1e4;

export type Bounds = { lo: number[]; hi: number[] };

/** 점들을 감싸는 바운딩 박스. each가 점마다 visit(x, y, z)를 부른다. 점이 없으면 lo가 Infinity다. */
export function boundsOf(each: (visit: (x: number, y: number, z: number) => void) => void): Bounds {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  each((...p) => {
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c], p[c]);
      hi[c] = Math.max(hi[c], p[c]);
    }
  });
  return { lo, hi };
}

/** 바운딩 박스 대각선 길이 */
export const diagonal = ({ lo, hi }: Bounds) => Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
