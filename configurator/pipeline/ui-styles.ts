// UI 스타일 목록: 저장소 포트가 UI 스타일 단계에 내주는 초기 내용. 사람이 관리하고, AI는 여기서 고르기만 한다(ADR-0001).
import type { Style } from "../src/style.ts";

const SANS = '"Pretendard", "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

export const UI_STYLES: Style[] = [
  {
    id: "natural",
    summary: "밝은 나무색과 갈색 강조, 가는 슬라이더. 원목 가구와 따뜻한 거실 분위기",
    colors: { background: "#f4f1ea", text: "#3b3026", accent: "#a47551", parts: ["#d8c3a5", "#a47551", "#8e8d8a", "#c9ada1", "#7d8a6a"] },
    font: SANS,
    slider: "thin",
  },
  {
    id: "dark",
    summary: "짙은 회색 바탕에 금색 강조, 굵은 슬라이더. 무광 블랙·월넛 가구와 고급스러운 분위기",
    colors: { background: "#26262a", text: "#ece8e1", accent: "#c8a24a", parts: ["#5b4a3f", "#8a8580", "#3f3f44", "#a3886a", "#6e6259"] },
    font: SANS,
    slider: "bold",
  },
  {
    id: "minimal",
    summary: "흰 바탕에 검정 강조, 각진 슬라이더. 화이트·스틸 가구와 사무실·모던 분위기",
    colors: { background: "#ffffff", text: "#1d1d1f", accent: "#1d1d1f", parts: ["#e8e8e6", "#b9bcbf", "#8c9196", "#d6d2c8", "#5f6468"] },
    font: '"Noto Sans KR", "Helvetica Neue", Arial, sans-serif',
    slider: "square",
  },
];
