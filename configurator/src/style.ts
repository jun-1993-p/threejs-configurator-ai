// UI 스타일: 고정 코어가 구성기에 입히는 색·글꼴·슬라이더 모양. AI는 UI 스타일 목록에서 하나를 고르기만 한다(ADR-0001).
// 고정 코어 번들에 들어가므로 ajv를 끌어오는 pipeline/schemas.ts 대신 여기에 값 목록을 둔다.

/** 슬라이더 모양. 고정 코어가 모양마다 정해 둔 CSS만 쓴다. */
export const SLIDER_SHAPES = ["thin", "bold", "square"] as const;
export type SliderShape = (typeof SLIDER_SHAPES)[number];

/** "#rrggbb". UI 스타일 목록 검사(pipeline/schemas.ts의 checkStyles)가 형식을 본다. */
export type HexColor = string;

export interface Style {
  id: string;
  /** AI가 고를 때 읽는 한 줄 설명 */
  summary: string;
  /** parts는 부품마다 돌려 쓰는 색이다 */
  colors: { background: HexColor; text: HexColor; accent: HexColor; parts: HexColor[] };
  /** CSS font-family */
  font: string;
  slider: SliderShape;
}
