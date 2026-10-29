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
| `sliders[].id` | 부모 파라미터의 Fusion 이름 | Fusion 사용자 파라미터에 있어야 하고, 업로드 묶음에 그 스윕이 있어야 한다 |
| `sliders[].name` | 슬라이더 이름(한국어) | AI가 짓고, 최종 승인에서 고칠 수 있다 |
| `sliders[].axis` | 슬라이더가 움직이는 축 | 축 반응으로 검증한다 |
| `sliders[].min/max` | 범위 | 치수 규칙 ∩ 정보 입력 메모 ∩ 스윕 범위 안에서 AI가 고른다(ADR-0009) |
| `sliders[].source` | 범위의 근거가 된 치수 규칙 | 치수 규칙에 있는 항목이어야 한다 |
| `sliders[].default` | 기본값 | 업로드된 Fusion 모델의 현재 값 |
| `sliders[].step`, `unit` | 슬라이더 단위 | AI |
| `sliders[].children` | 이 부모를 따르는 자식 파라미터 | 기록과 검증용. 변형 엔진은 읽지 않는다(ADR-0003) |
| `sliders[].affects.shape` | 형태 변경 부품 | 업로드 묶음의 부품 이름이어야 한다. 단독 스윕의 축 반응과 비교한다 |
| `sliders[].affects.move` | 위치 이동 부품 | 위와 같고, `shape`와 겹칠 수 없다 |
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
  "measured": { "value": 950, "axis": "W", "size_delta_mm": 14.2, "move_mm": 7.1 },
  "expected": "위치 이동만",
  "hint": "칸막이_좌를 위치 이동 부품으로 옮기거나, 자식 수식 확인"
}
```

- `path`: 고칠 명세 위치.
- `kind`: 정해진 목록(`configurator/pipeline/feedback.ts`의 `FEEDBACK_KINDS`).

  | `kind` | 뜻 |
  | --- | --- |
  | `dimension_error` | 치수 오차 초과 |
  | `shape_error` | 형상 오차 초과 |
  | `unexpected_shape_change` | 예상하지 못한 형태 변경 |
  | `off_axis_change` | 다른 축 변화 |
  | `missing_axis_change` | 선언한 축 반응 없음(형태 변경 부품의 치수, 위치 이동 부품의 자리가 그대로) |
  | `unexpected_move` | 예상하지 못한 위치 이동 |
  | `thickness_change` | 두께 변화(두께 고정 위반) |
  | `topology_change` | 위상 변화 |
  | `recompute_failed` | 재계산 실패 |
  | `range_shrunk` | 범위 축소 |
  | `modeling_error_suspected` | 모델링 오류 의심 |
  | `volume_jump` | 부피 튐(경고) |
  | `no_range_intersection` | 범위 교집합 없음 |
  | `ai_judgment` | AI 판정(이미지 경로와 이유 한 줄 포함) |

- `part`: 부품과 무관한 실패(검증점 재계산 실패·위상 변화)는 빈 문자열이다.
- `hint`: 규칙으로 만든다(AI가 쓰지 않음).

### 수치 검증 (ADR-0012)

업로드 묶음의 단독 스윕마다 `checks`(이웃 샘플 사이 가운데 값의 Fusion 형상, 검증점)가 있다. 슬라이더 범위 안의 검증점마다 그 슬라이더만 검증점 값으로 두고(나머지는 `default`) 변형 결과를 잰다.

- 치수 오차: 부품별 W·D·H(`axes`에 따른 바운딩 박스 길이)와 판재 두께가 0.2 mm를 넘으면 `dimension_error`. 판재 두께는 같은 바디에서 서로 등진 두 평면 중 기본 형상 간격이 30 mm(표준 두께 목록의 최댓값) 이하인 쌍의 간격이며, 부품마다 가장 크게 어긋난 판 하나를 알린다.
- 형상 오차: 부품별로 같은 꼭짓점끼리 잰 거리의 최댓값이 max(1 mm, 그 검증점 Fusion 형상 바운딩 박스 대각선의 0.1%)를 넘으면 `shape_error`.
- `path`는 검증점이 기본값보다 작으면 `sliders[i].min`, 크면 `sliders[i].max`이고, 힌트는 그쪽 범위를 검증점 값 안쪽으로 좁히라고 한다.

```json
{
  "path": "sliders[0].max",
  "slider": "body_w",
  "part": "DrawerBox",
  "kind": "dimension_error",
  "measured": { "value": 825, "dimension": "W", "engine_mm": 785, "fusion_mm": 785.3, "error_mm": 0.3 },
  "expected": { "max_error_mm": 0.2 },
  "hint": "DrawerBox의 W가 825에서 Fusion과 0.3 mm 다릅니다. body_w의 max를 825보다 작게 좁히세요"
}
```

두께는 `measured.dimension`이 `thickness`이고 `faces`에 판의 두 면 이름이 붙는다. 형상 오차의 `measured`는 `{ value, error_mm }`, `expected`는 `{ max_error_mm }`이다.

### 축 반응

수치 검증을 통과한 명세만 본다. 업로드 묶음의 단독 스윕에서 슬라이더 범위 안의 샘플과 검증점(재계산 성공, 기본값 제외)마다, 부품의 W·D·H별 치수(바운딩 박스 길이)와 가운데 위치가 기본 형상에서 얼마나 바뀌었는지 Fusion 형상으로 잰다. 부품은 그 바디의 모든 면으로 재므로 면 구성이 바뀐 샘플도 잴 수 있다. 0.2 mm(치수 오차 합격선과 같은 값)를 넘으면 바뀐 것으로 본다. "바뀌지 않는다"는 범위 안에서 가장 크게 바뀐 샘플도 0.2 mm 이하라는 뜻이다. 한 축에 슬라이더가 여러 개여도(전체 폭·서랍 폭) 슬라이더마다 따로 본다.

| 부품 | 슬라이더 축에서 기대 | 어기면 `kind` | `path` |
| --- | --- | --- | --- |
| `affects.shape` | 치수가 바뀐다 | `missing_axis_change` | `sliders[i].affects.shape` |
| `affects.move` | 치수는 그대로, 자리가 옮겨진다 | 치수가 바뀌면 `unexpected_shape_change`, 자리가 그대로면 `missing_axis_change` | `sliders[i].affects.move` |
| 선언하지 않은 부품 | 그대로 | 치수가 바뀌면 `unexpected_shape_change`(`affects.shape`), 자리가 옮겨지면 `unexpected_move`(`affects.move`) | 괄호 안 |
| 모든 부품 | 다른 축의 치수와 위치가 그대로 | `off_axis_change` | `sliders[i].axis` |

- 표는 위에서부터 보고, 부품마다 처음 걸린 행 하나(와 다른 축 변화)만 알린다. 알리는 샘플은 그 양이 가장 크게 바뀐 샘플이다. `measured`는 `{ value, axis, size_delta_mm, move_mm }`(그 샘플 값, 잰 축, 치수 변화, 가운데 위치 변화)이다.
- 힌트는 부품을 어느 목록에 넣거나 빼라고 하고, 자식 수식도 확인하라고 한다.

### 교차 검증 (ADR-0004, ADR-0013)

수치 검증과 축 반응을 통과한 명세만 본다. 슬라이더가 둘 이상이면 서버가 애드인에 교차 검증 샘플을 요청한다. 슬라이더 쌍마다 두 범위의 모서리 조합 4곳(`min`·`max` × `min`·`max`, 나머지 슬라이더는 `default`)이고, 이 값 묶음으로 변형 결과(단독 스윕 이동량의 덧셈)와 받은 Fusion 형상을 비교한다.

- 재는 방법과 합격선은 수치 검증과 같다(형상 오차, 부품별 W·D·H와 판 두께의 치수 오차, 재계산 실패, 위상 변화).
- `path`는 쌍의 앞 슬라이더 `sliders[i]`, `slider`는 그 슬라이더다. `measured.values`에 쌍의 두 슬라이더 값이 있어 어느 쌍인지 알 수 있다.
- 힌트는 한쪽을 다른 쪽의 자식으로 두거나 두 범위를 좁히라고 한다(ADR-0008).

```json
{
  "path": "sliders[0]",
  "slider": "body_d",
  "part": "DrawerBox",
  "kind": "dimension_error",
  "measured": { "values": { "body_d": 600, "drawer_d": 600 }, "dimension": "D", "engine_mm": 750, "fusion_mm": 600, "error_mm": 150 },
  "expected": { "max_error_mm": 0.2 },
  "hint": "DrawerBox의 D가 body_d=600·drawer_d=600에서 Fusion과 150 mm 다릅니다. body_d와 drawer_d를 함께 움직이면 덧셈이 맞지 않습니다. 한쪽을 다른 쪽의 자식으로 두거나 두 범위를 좁히세요"
}
```

애드인 연결이 끊겨 있으면 실패로 세지 않는다. 처리 기록에 `{ "fusion": "Fusion 연결 필요" }`를 남기고 기다렸다가, 다시 연결되면 `{ "fusion": "다시 연결됨" }`을 남기고 같은 요청을 다시 보낸다. 애드인이 샘플을 뽑지 못했다고 알리거나(모델에 없는 파라미터, Fusion API 오류) 응답이 형식(업로드 묶음 스키마의 `sampleResponse`)에 맞지 않으면 검증 단계에서 멈춘다.

### 재시도

- 같은 후보로 피드백과 재시도를 3번 넘게 거쳐도(처음 명세 + 다시 쓰기 3번) 통과하지 못하면, 마지막 피드백을 실패 이유로 붙여(`failures`) 후보 제시로 돌아간다.
- 수치 검증과 축 반응은 통과했는데 AI 판정만 3번 실패하면, 판정 이유를 붙여 최종 승인으로 넘기고 사람이 결정한다.
