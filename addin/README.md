# CAD 애드인과 업로드 서버

## 서버 실행

```
python -m venv .venv
.venv\Scripts\python -m pip install -e .[dev]
.venv\Scripts\uvicorn server.main:app --host 0.0.0.0 --port 8000
```

- 업로드 묶음은 `data/uploads/`, 녹화본은 `fixtures/private/recordings/`에 저장된다. 둘 다 `.gitignore` 대상이므로 실제 상품 데이터는 공개 저장소에 올라가지 않는다.
- 위치는 `CONFIGURATOR_DATA_DIR`, `CONFIGURATOR_RECORDINGS_DIR` 환경 변수로 바꾼다.

## 애드인 설치

> 지금은 Fusion 애드인으로 업로드할 수 없다. 업로드 묶음이 면 이름·모서리·연결 정보를 요구하게 바뀌었는데(ADR-0016, 티켓 25), Fusion 쪽 추출은 사람 확인 전이라 `sample_edges`가 오류를 낸다. 그동안 시험 데이터는 SolidCraft 합성 녹화본(`python -m synthetic.make_recording`, 티켓 24)으로 만든다.

1. Fusion → 유틸리티 → 추가 기능 → 스크립트 및 추가 기능 → 추가 기능 탭 → `+` 로 `addin/ConfiguratorUploader` 폴더를 연결한다.
2. 서버 주소는 `addin/ConfiguratorUploader/config.py`의 `SERVER_URL`에서 바꾼다.
3. 추가 기능을 실행하면 스크립트·추가 기능 패널에 "구성기 업로드" 버튼이 생긴다.

## 녹화본 만들기

준비 조건과 자세한 절차는 `docs/recording-guide.md`를 본다. 요약하면 다음과 같다.

1. 모델을 연 Fusion에서 "구성기 업로드"를 누른다. 완료 메시지에 업로드 ID가 나온다.
2. 서버에 녹화를 요청한다.

```
curl -X POST http://localhost:8000/uploads/<업로드 ID>/recording -H "Content-Type: application/json" -d "{\"name\": \"stool1\"}"
```

## 업로드 중에는

스윕은 Fusion 메인 스레드에서 돌기 때문에 끝날 때까지 Fusion 화면이 멈춘다(사용자 파라미터 수 × 5회 재계산).

- 단위가 없는 정수 파라미터(선반 수 등)는 개수형으로 보고 스윕하지 않는다. 샘플마다 그 값을 적는다.
- 기본값에서 범위 끝 쪽으로 가며 면 구성(바디·면 이름·표면 종류)이 처음 바뀌는 지점을 찾아, 그 앞 샘플까지로 스윕 범위를 줄인다. 개수형 값이 그대로인데 면 구성이 바뀌었으면 모델링 오류 의심으로 적는다(ADR-0005). 범위 안의 위상 묶음은 아직 나누지 않는다(티켓 11).

## 업로드 뒤에는

업로드가 끝나면 애드인은 최종 승인까지 서버에 연결된 채로 추가 샘플 요청(교차 검증 샘플 등)에 답한다(ADR-0013). Fusion과 업로드한 디자인 문서를 열어 둔다.

- 일꾼 스레드가 3초마다 사용자 이벤트를 쏘고, 주 스레드가 `GET /uploads/<ID>/sample-requests/next`로 요청을 가져가 `POST .../<요청 ID>/response`로 답한다. 샘플을 뽑지 못하면 `POST .../<요청 ID>/failure`로 이유를 알린다(바꾼 파라미터의 수식은 되돌린다). 샘플을 뽑는 동안에는 일꾼 스레드가 `POST /uploads/<ID>/fusion`으로 연결 신호를 보낸다.
- 서버는 애드인 소식이 15초 넘게 없으면 연결이 끊긴 것으로 보고, 파이프라인은 "Fusion 연결 필요"로 기다린다.
- 새로 업로드하면 그 업로드의 요청에만 답한다.
- Fusion 안에서의 이 연결 동작은 아직 사람이 확인하지 않았다(Fusion 업로드 자체가 티켓 25 사람 확인을 기다린다).
