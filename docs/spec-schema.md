# 명세(JSON) 스키마

상품 하나의 명세 구조. AI가 쓰는 유일한 산출물이다(ADR-0001). 용어는 `GLOSSARY.md`를 따른다.

## 예시

```json
{
  "product": "3단 서랍장",
  "front": "-Y",
  "axes": { "W": "X", "D": "Y", "H": "Z" },
  "sliders": [
    {
      "id": "W_total",
      "name": "전체 폭",
      "axis": "W",
      "min": 600, "max": 1200, "default": 800, "step": 10, "unit": "mm",
      "source": "치수규칙/서랍장/폭",
      "children": ["drawer_w", "divider_x"],
      "affects": { "shape": ["상판", "하판", "서랍_1"], "move": ["측판_우"] }
    }
  ],
  "thickness": [
    { "ids": ["t_body"], "name": "몸통 두께", "default": 18, "options": [15, 18, 24] }
  ],
  "fixed": ["t_back", "t_drawer_bottom"]
}
```

## 필드

| 필드 | 뜻 | 누가 정하나 / 검증 |
| --- | --- | --- |
| `product` | 상품명 | 정보 입력에서 가져온다 |
| `front` | 정면 방향(Fusion 좌표 기준) | AI가 추정한다. 확신이 없으면 후보끼리 다르게 둔다 |
| `axes` | W 폭·D 깊이·H 높이와 Fusion 축의 대응 | `front`에서 정해진다 |
| `sliders[].id` | 부모 파라미터의 Fusion 이름 | Fusion 사용자 파라미터에 있어야 한다 |
| `sliders[].name` | 슬라이더 이름(한국어) | AI가 짓고, 최종 승인에서 고칠 수 있다 |
| `sliders[].axis` | 슬라이더가 움직이는 축 | 축 반응으로 검증한다 |
| `sliders[].min/max` | 범위 | 치수 규칙 ∩ 정보 입력 메모 ∩ 스윕 범위 안에서 AI가 고른다(ADR-0009) |
| `sliders[].source` | 범위의 근거가 된 치수 규칙 | 치수 규칙에 있는 항목이어야 한다 |
| `sliders[].default` | 기본값 | 업로드된 Fusion 모델의 현재 값 |
| `sliders[].step`, `unit` | 슬라이더 단위 | AI |
| `sliders[].children` | 이 부모를 따르는 자식 파라미터 | 기록과 검증용. 변형 엔진은 읽지 않는다(ADR-0003) |
| `sliders[].affects.shape` | 형태 변경 부품 | 단독 스윕의 축 반응과 비교한다 |
| `sliders[].affects.move` | 위치 이동 부품 | 단독 스윕의 축 반응과 비교한다 |
| `thickness[].ids` | 하나의 두께 선택으로 묶인 두께 파라미터 | 같은 기본 두께여야 한다 |
| `thickness[].name` | 두께 선택의 이름 | AI |
| `thickness[].options` | 두께 후보 | 표준 두께 목록에서 기본 두께의 앞뒤 한 칸이어야 한다(ADR-0010) |
| `fixed` | 고정 두께 파라미터 | 어떤 슬라이더의 `children`에도 들어갈 수 없다 |

## 명세에 적지 않는 것

- 개수형 파라미터와 위상 묶음: 애드인이 찾아 스윕 결과에 담는다(ADR-0005).
- 스윕 샘플 위치: 애드인이 업로드 때 적응형으로 정한다(ADR-0007).
- 격자 보강 쌍: 애드인 결과에 담는다(ADR-0008).

## 검증 피드백

실패 하나당 항목 하나.

```json
{
  "path": "sliders[2].affects.shape",
  "slider": "drawer_w",
  "part": "칸막이_좌",
  "kind": "unexpected_shape_change",
  "measured": { "axis": "W", "delta_mm": 14.2 },
  "expected": "위치 이동만",
  "hint": "칸막이_좌를 위치 이동 부품으로 옮기거나, 자식 수식 확인"
}
```

- `path`: 고칠 명세 위치.
- `kind`: 정해진 목록 — 치수 오차 초과, 형상 오차 초과, 예상하지 못한 형태 변경, 다른 축 변화, 두께 변화, 위상 변화, 재계산 실패, 범위 축소, 범위 교집합 없음, AI 판정(`ai_judgment`, 이미지 경로와 이유 한 줄 포함).
- `hint`: 애드인이 규칙으로 만든다(AI가 쓰지 않음).
- 같은 명세가 피드백과 재시도를 3번 넘게 거쳐도 통과하지 못하면, 실패 이유를 붙여 후보 제시로 돌아간다.
- 수치 검증과 축 반응은 통과했는데 AI 판정만 3번 실패하면, 판정 이유를 붙여 최종 승인으로 넘기고 사람이 결정한다.
