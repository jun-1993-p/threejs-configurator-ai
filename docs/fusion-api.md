# Fusion API 함정

애드인(`addin/ConfiguratorUploader`)과 탐색 스크립트(`addin/FaceNameProbe`)를 고치기 전에 읽는다. Fusion API 문서와 실제 동작이 다르거나, 문서에 없는 동작이다. 항목마다 근거와 그 동작에 맞춘 코드를 적는다. **확인**은 실제 Fusion에서 본 것이고, **추정**은 아직 원인을 확인하지 못한 것이다.

## 단위

- **`unitsManager.convert`는 단위가 맞지 않으면 예외를 낸다(확인).** 문서는 -1을 돌려준다고 하지만, 실제로는 `RuntimeError("6 : The input and output units are not compatible")`를 낸다. 각도처럼 길이가 아닌 파라미터에서 업로드가 첫 줄에 멈췄다(티켓 26 2절). → `fusion_model._convertible`, `FaceNameProbe._is_length`

## 곡선과 표면 평가기

- **`CurveEvaluator3D.getPointAtParameter`는 범위 밖 매개변수에 예외를 낸다(확인).** `RuntimeError("3 : invalid argument parameter")`. → `fusion_model._edge_points`
- **`getParameterAtLength`의 결과가 범위를 조금 넘을 수 있다(추정).** 위 예외의 원인으로 보지만 확인하지 못했다. 그래서 끝점은 `getParameterExtents`의 끝값을 그대로 쓰고, 범위 길이의 1e-6 안쪽 넘침만 묶는다. 더 크게 넘으면 오류로 알린다. 그 오류가 나면 원인이 다른 것이다.
- `SurfaceEvaluator.getPointsAtParameters`는 `[bool, Point3D 목록]`을 돌려준다(확인). 어댑터는 더는 쓰지 않는다.
- `BRepFace.pointOnFace`는 Fusion이 고르는 점이라 샘플마다 같다는 보장이 없다. 순번을 정하는 열쇠로는 `centroid`를 쓴다(`fusion_model._order`).
- 면 정의(`face.geometry`)의 평면 법선은 면의 바깥쪽과 반대일 수 있다. 바깥 법선은 `evaluator.getNormalAtPoint(pointOnFace)`로 얻는다(`_normal`).
- 원기둥 정의의 축 부호는 재계산 뒤에도 같다는 보장이 없다. 부호를 정해 쓴다(`face_sampling.canonical_axis`).

## 면과 모서리의 정체성 (재계산 사이)

`tempId`·옆면 순서·`entityToken`·면 표시가 재계산 뒤 어떻게 되는지와, 그래서 면 이름을 면 표시로 이어 가는 까닭은 ADR-0016 「바뀐 것」에 있다(확인, 평면만 있는 모델). 면이 갈라지거나 새로 생길 때 표시가 어떻게 되는지는 아직 보지 못했다.

## 원과 원기둥

- 원으로 돌출한 원기둥 면(구멍 등)에는 이음선 모서리가 없다. 고리는 닫힌 원 모서리 하나씩이고, 그 모서리는 시작 꼭짓점과 끝 꼭짓점이 같다. 경계 맞춤 격자가 펼칠 자리가 없어서 어댑터가 반쪽 원기둥 둘로 나눈다(`face_sampling.split_circle`, `seam`). 실제 Fusion 모델로는 아직 확인하지 못했다.

## 어셈블리

- `rootComponent.allOccurrences`의 오커런스 안 바디(`occurrence.bRepBodies`)는 어셈블리 좌표의 프록시다. 본래 컴포넌트의 면은 `nativeObject`로 얻고, 면 표시는 본래 면에 붙인다.
- 프록시와 `transform2`가 맞는지는 업로드마다 애드인이 잰다(`SelfChecks`, 점검 파일). 컴포넌트를 옮긴 실제 모델로는 아직 보지 못했다.

## 애드인 실행

- 애드인 코드를 고치면 "스크립트 및 추가 기능" 창에서 **중지한 뒤 다시 실행**해야 새 코드를 읽는다. 다시 실행하지 않으면 예전 코드로 업로드한다(점검 파일이 없으면 이것을 의심한다).
- Fusion API는 주 스레드에서만 부른다(ADR-0013).
- 실패 기록 파일과 점검 파일은 녹화 안내서 4-3에 있다. 탐색 스크립트의 실패는 `data/probes/last-error.txt`에 남는다.
