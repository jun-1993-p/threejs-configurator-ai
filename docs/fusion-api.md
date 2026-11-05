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

- **바디 이름(`BRepBody.name`)은 재계산 뒤 바뀔 수 있다(확인, 티켓 26 4절).** 한 돌출이 만든 바디 둘 중 하나가, 파라미터 하나를 바꾸자 `본체3`에서 `본체4`가 되었고 되돌려도 그대로였다. 그 바디 면의 표시는 남아 있었다. 그래서 어댑터는 기본 형상의 바디 이름을 바디 표시로 붙여 이어 가고, 이어 답할 때도 바디 표시를 지우지 않는다(`FusionDesignModel._body_name`). 바디 표시가 이름이 바뀐 바디에도 남는지는 다시 업로드해 본다(**추정**: 면 표시가 남았으니 같은 바디의 표시도 남는다). 남지 않으면 애드인 점검의 `untagged_bodies`에 나온다.

## 원과 원기둥

- 원으로 돌출한 원기둥 면(구멍 등)에는 이음선 모서리가 없다. 고리는 닫힌 원 모서리 하나씩이고, 그 모서리는 시작 꼭짓점과 끝 꼭짓점이 같다. 경계 맞춤 격자가 펼칠 자리가 없어서 어댑터가 반쪽 원기둥 둘로 나눈다(`face_sampling.split_circle`, `seam`). 실제 Fusion 모델로는 아직 확인하지 못했다.

## 어셈블리

- **패턴이 만든 오커런스는 재계산마다 다시 만들어져 인스턴스 번호가 바뀐다(확인, 티켓 26 2절 선반).** `fullPathName`이 `구성요소1:12`에서 `구성요소1:16`으로 바뀌어, 그 경로를 부품 이름으로 쓰자 부품이 사라지고 새로 생긴 것으로 보여 스위프 범위 7개가 모두 폭 0으로 줄었다. 손으로 넣은 오커런스(`:1`~`:3`)와 거울 복사본은 번호가 그대로였다. 그래서 부품 이름은 번호를 뗀 컴포넌트 경로에 위치 순서의 순번을 붙인다(`part_names.stable_part_names`, 위치는 첫 바디의 어셈블리 좌표 경계 상자 최소점). 스윕으로 부품 위치의 순서가 뒤바뀌면 이름이 바뀔 수 있다.
- **`BRepBody.boundingBox`는 곡면이 있는 바디에서 꼭 맞는 상자보다 조금 클 수 있다(추정).** 확인하지 못했다. 바디 측정값의 경계 상자(`FusionDesignModel.measure_bodies`)는 그래서 SolidCraft의 꼭 맞는 상자와 뜻이 다를 수 있다. 지금 파이프라인은 바디 부피만 쓴다(`volume_jump`).
- **단위를 지우는 수식의 값에는 부동소수 잡음이 낀다(확인).** `floor(shelf_w / 400 mm) + 1`이 `3.0000000000000004`로 나와 개수형이 아닌 연속 치수로 잡혔다. `is_count`가 정수에서 1e-9 안쪽이면 정수로 본다.
- `rootComponent.allOccurrences`의 오커런스 안 바디(`occurrence.bRepBodies`)는 어셈블리 좌표의 프록시다. 본래 컴포넌트의 면은 `nativeObject`로 얻고, 면 표시는 본래 면에 붙인다.
- 프록시와 `transform2`가 맞는지는 업로드마다 애드인이 잰다(`SelfChecks`, 점검 파일). 컴포넌트를 옮긴 실제 모델로는 아직 보지 못했다.

## 애드인 실행

- 애드인 코드를 고치면 "스크립트 및 추가 기능" 창에서 **중지한 뒤 다시 실행**해야 새 코드를 읽는다. 다시 실행하지 않으면 예전 코드로 업로드한다(확인, 두 번째 녹화). 그래서 애드인은 실행할 때 `data/addin-checks/loaded.txt`를 쓰고, 녹화 위저드는 그보다 새로 고친 애드인 코드가 있으면 업로드로 넘어가지 않는다.
- 다시 실행할 때 Fusion이 하위 모듈(`uploader.*`)을 `sys.modules`에서 비우는지는 확인하지 못했다. 그래서 애드인이 시작할 때 자기 패키지의 하위 모듈을 스스로 지운다(`ConfiguratorUploader.py` 머리).
- Fusion API는 주 스레드에서만 부른다(ADR-0013).
- **`ui.messageBox`는 닫을 때까지 주 스레드를 막는다(확인, 티켓 26 선반).** 그동안 일꾼 스레드의 사용자 이벤트를 처리하지 않아 추가 샘플 요청에 답하지 못했다. 그래서 업로드 완료는 텍스트 명령 창(`ui.palettes.itemById("TextCommands")`의 `writeText`)에 알린다. 메시지 창 없이 이 창에 글이 찍힌다(확인, 티켓 33). 못 쓰면 `last-error.txt`에 "알림 실패"로 남는다.
- **`design.attributes`에 쓴 업로드 ID는 문서를 저장하고 Fusion을 껐다 켠 뒤에도 남는다(확인, 티켓 26 3절).** 같은 그룹에 `upload_id` 속성을 둔다(`ConfiguratorUploader._DocumentUploadId`).
- **문서 열림 이벤트에는 걸지 않는다.** 이벤트 동작은 확인하지 못했다. 답하는 업로드가 없는 동안 3초마다 `activeProduct`를 읽어 문서에 적힌 업로드를 찾고(`_Serving._resume`), 껐다 켠 뒤 6초 안에 이어 답하는 것을 확인했다.
- 실패 기록 파일과 점검 파일은 녹화 안내서 4-3에 있다. 탐색 스크립트의 실패는 `data/probes/last-error.txt`에 남는다.
