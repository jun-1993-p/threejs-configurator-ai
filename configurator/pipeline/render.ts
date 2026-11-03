// 서버(Node)에서 형상을 PNG로 그린다. 부품 탐색(VLM)에 보낼 여섯 방향 그림과 후보 카드의 변형 미리보기에 쓴다.
// WebGL 없이 직교 투영·깊이 버퍼·면 음영만으로 삼각형을 칠한다. 부품마다 색이 달라 VLM이 색으로 부품을 가린다.
import { deflateSync, crc32 } from "node:zlib";

import type { MorphShape, Vector } from "../src/engine.ts";

/** eye: 형상 쪽에서 카메라 쪽으로 향하는 방향, up: 그림 위쪽이 될 방향 */
export interface View {
  eye: Vector;
  up: Vector;
}

export type Rgb = [number, number, number];

const BACKGROUND: Rgb = [244, 244, 242];

/** 부품마다 돌려 쓰는 색. 고정 코어가 쓰는 UI 스타일의 부품 색보다 서로 잘 구별되게 골랐다. */
const PART_COLORS: Rgb[] = [
  [214, 170, 110],
  [70, 120, 180],
  [200, 80, 70],
  [90, 160, 90],
  [150, 100, 170],
  [230, 200, 60],
];

/**
 * n번째 부품 색. 정해 둔 색이 모자라면 색상환을 황금각(약 137.5°)씩 돌리고 밝기를 번갈아 바꿔 만든다.
 * VLM이 색으로 부품을 가리므로 부품마다 다른 색이어야 한다.
 */
function partColor(n: number): Rgb {
  if (n < PART_COLORS.length) return PART_COLORS[n];
  const hue = ((n - PART_COLORS.length) * 137.508 + 20) % 360;
  const [s, l] = [0.55, n % 2 === 0 ? 0.42 : 0.65];
  // HSL → RGB
  const a = s * Math.min(l, 1 - l);
  const channel = (m: number) => {
    const k = (m + hue / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}

/** 부품 이름마다 색. 업로드 묶음의 부품 순서로 정하고, 부품에 들지 않은 면(바디 이름)은 그 뒤로 이어 붙인다. */
export function partPalette(parts: string[]): (part: string) => Rgb {
  const colors = new Map(parts.map((part, i) => [part, partColor(i)]));
  return (part) => {
    if (!colors.has(part)) colors.set(part, partColor(colors.size));
    return colors.get(part)!;
  };
}

export const hex = ([r, g, b]: Rgb) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

const sub = (a: Vector, b: Vector): Vector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vector, b: Vector): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v: Vector): Vector => {
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
};

/**
 * 같은 시점·같은 축척으로 형상마다 PNG 하나를 그린다. 축척은 모든 형상을 함께 담도록 맞춰,
 * 슬라이더 끝값끼리 그림을 나란히 놓으면 크기 차이가 그대로 보인다.
 */
export function renderPngs(shapes: MorphShape[], view: View, size: { width: number; height: number }, colorOf: (part: string) => Rgb): Buffer[] {
  const back = normalize(view.eye);
  const right = normalize(cross(view.up, back));
  const up = cross(back, right);
  const light = normalize([back[0] + 0.5 * up[0] + 0.3 * right[0], back[1] + 0.5 * up[1] + 0.3 * right[1], back[2] + 0.5 * up[2] + 0.3 * right[2]]);

  // 화면 좌표(오른쪽, 위)의 범위를 모든 형상에서 모은다
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const { positions } of shapes) {
    for (let i = 0; i < positions.length; i += 3) {
      const p: Vector = [positions[i], positions[i + 1], positions[i + 2]];
      const [x, y] = [dot(p, right), dot(p, up)];
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
  }
  const { width, height } = size;
  const margin = 0.08;
  const scale = Math.min((width * (1 - 2 * margin)) / (x1 - x0 || 1), (height * (1 - 2 * margin)) / (y1 - y0 || 1));
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];

  return shapes.map((shape) => {
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) rgb.set(BACKGROUND, i * 3);
    const depth = new Float64Array(width * height).fill(-Infinity);
    const partOf = new Array<string>(shape.positions.length / 3);
    for (const face of shape.faces) partOf.fill(face.part, face.start, face.start + face.count);

    const at = (k: number): Vector => [shape.positions[k * 3], shape.positions[k * 3 + 1], shape.positions[k * 3 + 2]];
    const t = shape.triangles;
    for (let i = 0; i < t.length; i += 3) {
      const corners = [at(t[i]), at(t[i + 1]), at(t[i + 2])];
      const normal = cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
      if (Math.hypot(...normal) === 0) continue;
      // 양면으로 칠한다: 법선이 어느 쪽이든 빛과 이루는 각도만 본다
      const shade = 0.35 + 0.65 * Math.abs(dot(normalize(normal), light));
      const [r, g, b] = colorOf(partOf[t[i]]).map((ch) => Math.round(ch * shade));
      // 화면 픽셀 좌표(아래로 갈수록 y가 크다)와 깊이(카메라에 가까울수록 크다)
      const screen = corners.map((p) => [width / 2 + (dot(p, right) - cx) * scale, height / 2 - (dot(p, up) - cy) * scale, dot(p, back)]);
      const [[ax, ay, az], [bx, by, bz], [qx, qy, qz]] = screen;
      const area = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
      if (area === 0) continue;
      const left = Math.max(0, Math.floor(Math.min(ax, bx, qx)));
      const rightEdge = Math.min(width - 1, Math.ceil(Math.max(ax, bx, qx)));
      const top = Math.max(0, Math.floor(Math.min(ay, by, qy)));
      const bottom = Math.min(height - 1, Math.ceil(Math.max(ay, by, qy)));
      for (let py = top; py <= bottom; py++) {
        for (let px = left; px <= rightEdge; px++) {
          const sx = px + 0.5;
          const sy = py + 0.5;
          const wa = ((bx - sx) * (qy - sy) - (by - sy) * (qx - sx)) / area;
          const wb = ((qx - sx) * (ay - sy) - (qy - sy) * (ax - sx)) / area;
          const wc = 1 - wa - wb;
          if (wa < 0 || wb < 0 || wc < 0) continue;
          const z = wa * az + wb * bz + wc * qz;
          const k = py * width + px;
          if (z <= depth[k]) continue;
          depth[k] = z;
          rgb[k * 3] = r;
          rgb[k * 3 + 1] = g;
          rgb[k * 3 + 2] = b;
        }
      }
    }
    return encodePng(rgb, width, height);
  });
}

/** 8비트 RGB PNG. 줄마다 필터 없음(0)으로 둔다. */
export function encodePng(rgb: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
