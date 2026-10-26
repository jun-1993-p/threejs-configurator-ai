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
