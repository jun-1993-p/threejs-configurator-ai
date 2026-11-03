// VLM에 보내는 모음 그림: 칸(그림 하나)을 격자로 이어 붙인 PNG 한 장. VLM은 요청 하나에 받는 그림 수가 정해져 있어
// (Groq qwen은 3장, 티켓 26 6절) 부품 탐색의 여섯 방향 그림과 AI 판정 렌더링을 칸으로 묶어 보낸다.
// 칸은 크기를 바꾸지 않고 옮겨 붙이기만 해서, 같은 축척으로 그린 렌더링은 모음 그림에서도 같은 축척이다.
import { inflateSync } from "node:zlib";

import { encodePng, type Rgb } from "./render.ts";

/** 모음 그림 한 장의 격자. 320×240 칸이면 한 장이 968×728이다. */
export const SHEET_COLUMNS = 3;
const SHEET_ROWS = 3;
export const SHEET_CELLS = SHEET_COLUMNS * SHEET_ROWS;

/** 칸 사이 경계(픽셀)와 색. 렌더링 바탕색(밝은 회색)과 구별되게 어둡게 둔다. */
const GAP = 4;
const GAP_COLOR: Rgb = [120, 120, 120];

/** 그림 하나가 놓인 자리: 요청에 붙인 모음 그림의 순서(sheet), 그 안의 줄(row)과 칸(column). 모두 1부터 센다. */
export interface Cell {
  sheet: number;
  row: number;
  column: number;
}

interface Image {
  width: number;
  height: number;
  rgb: Uint8Array;
}

/** 8비트 RGB, 비월 없는 PNG를 읽는다. 모음 그림에 넣는 그림은 render.ts가 그린 것이라 이 형식만 받는다. */
export function decodePng(png: Buffer): Image {
  // 시그니처 뒤 첫 청크가 IHDR이어야 너비·높이·형식을 고정 위치에서 읽을 수 있다
  if (png.toString("latin1", 1, 4) !== "PNG" || png.toString("latin1", 12, 16) !== "IHDR") throw new Error("모음 그림에 넣을 그림이 PNG가 아닙니다");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const [depth, colorType, , , interlace] = png.subarray(24, 29);
  if (depth !== 8 || colorType !== 2 || interlace !== 0) throw new Error(`모음 그림에 넣을 수 없는 PNG 형식입니다(비트 ${depth}, 색 ${colorType}, 비월 ${interlace})`);
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 3;
  const rgb = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? rgb[y * stride + x - 3] : 0;
      const up = y > 0 ? rgb[(y - 1) * stride + x] : 0;
      const upLeft = x >= 3 && y > 0 ? rgb[(y - 1) * stride + x - 3] : 0;
      const p = left + up - upLeft;
      const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
      const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      const predict = [0, left, up, (left + up) >> 1, paeth][filter];
      rgb[y * stride + x] = (line[x] + predict) & 0xff;
    }
  }
  return { width, height, rgb };
}

/**
 * 그림(PNG, base64)을 순서대로 칸에 놓아 모음 그림을 만든다. 한 장에 SHEET_CELLS칸까지, 한 줄에 SHEET_COLUMNS칸까지다.
 * 칸 크기는 가장 큰 그림에 맞추고, 작은 그림은 칸 왼쪽 위에 그대로 놓는다(남는 곳은 경계색).
 */
export function imageSheets(images: string[]): { sheets: string[]; cells: Cell[] } {
  if (images.length === 0) return { sheets: [], cells: [] };
  const decoded = images.map((image) => decodePng(Buffer.from(image, "base64")));
  const cellWidth = Math.max(...decoded.map((d) => d.width));
  const cellHeight = Math.max(...decoded.map((d) => d.height));
  const cells = decoded.map((_, i) => ({
    sheet: Math.floor(i / SHEET_CELLS) + 1,
    row: Math.floor((i % SHEET_CELLS) / SHEET_COLUMNS) + 1,
    column: (i % SHEET_COLUMNS) + 1,
  }));
  const sheets: string[] = [];
  for (let start = 0; start < decoded.length; start += SHEET_CELLS) {
    const onSheet = decoded.slice(start, start + SHEET_CELLS);
    const columns = Math.min(SHEET_COLUMNS, onSheet.length);
    const rows = Math.ceil(onSheet.length / SHEET_COLUMNS);
    const width = columns * cellWidth + (columns - 1) * GAP;
    const height = rows * cellHeight + (rows - 1) * GAP;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) rgb.set(GAP_COLOR, i * 3);
    onSheet.forEach((image, k) => {
      const { row, column } = cells[start + k];
      const [left, top] = [(column - 1) * (cellWidth + GAP), (row - 1) * (cellHeight + GAP)];
      for (let y = 0; y < image.height; y++) rgb.set(image.rgb.subarray(y * image.width * 3, (y + 1) * image.width * 3), ((top + y) * width + left) * 3);
    });
    sheets.push(encodePng(rgb, width, height).toString("base64"));
  }
  return { sheets, cells };
}
