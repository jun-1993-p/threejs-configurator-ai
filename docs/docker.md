# Docker 운영

서버 전체를 LAN의 로컬 Docker 구성 하나(`docker-compose.yml`)로 띄운다(ADR-0015).

| 서비스 | 하는 일 | 주소 |
| --- | --- | --- |
| `server` | 업로드 묶음 받기, 애드인과 추가 샘플 요청 주고받기 | `http://<이 머신의 LAN 주소>:8000` |
| `litellm` | 모델 중계와 예비 모델 전환 | `http://<이 머신의 LAN 주소>:4000` |
| `ollama` | 로컬 모델(예비 LLM·VLM, 사례 저장소 임베딩) | 구성 안에서만 `http://ollama:11434` |
| `pipeline` | 파이프라인 실행 도구. 늘 떠 있지 않고 부를 때만 돈다 | — |

## 처음 띄우기

1. `.env.example`을 `.env`로 복사하고 값을 채운다. `.env`는 저장소에 올라가지 않는다.
   - `LITELLM_MASTER_KEY`는 반드시 정한다. 없으면 `docker compose`가 시작하지 않는다.
   - `CEREBRAS_API_KEY`·`GROQ_API_KEY`를 비우면 그 API는 실패하고 다음 예비 모델로 넘어간다.
2. `docker compose up -d --build`
3. 로컬 모델을 받는다. 임베딩은 늘 로컬이라 `embeddinggemma`는 꼭 필요하다.

   ```
   docker compose exec ollama ollama pull embeddinggemma
   docker compose exec ollama ollama pull gpt-oss:20b
   docker compose exec ollama ollama pull qwen3-vl:8b
   ```

4. 애드인의 서버 주소를 `http://<이 머신의 LAN 주소>:8000`으로 둔다. Windows 방화벽에서 8000번 포트를 연다.

업로드 묶음과 사례 저장소는 `data/`, 녹화본은 `fixtures/private/recordings/`에 남는다. 둘 다 컨테이너 밖 저장소 폴더이고 `.gitignore` 대상이다.

## 모델 바꾸기

파이프라인은 `llm`·`vlm`·`embedding`이라는 이름만 부른다. 실제 모델은 `docker/litellm/config.yaml`만 고쳐 바꾸고 `docker compose restart litellm`으로 반영한다.

- 예비 순서: `llm` → `llm-groq` → `llm-local`, `vlm` → `vlm-groq` → `vlm-local`(`router_settings.fallbacks`).
- 외부 API가 120초 안에 답하지 않거나 오류(키 없음, 사용량 초과 등)를 내면 다시 묻지 않고 다음 예비로 넘어간다. 파이프라인은 LiteLLM 답을 20분까지 기다린다(외부 둘이 답하지 않아 로컬 모델 900초까지 가는 시간보다 길게, `configurator/pipeline/litellm-ai.ts`). 제한 시간을 늘리면 그 값도 함께 늘린다.
- 로컬 모델은 OpenAI 호환 API만 기대한다. 다른 머신(예: GPU가 있는 PC, Mac의 LM Studio)에서 돌리려면 `.env`의 `LOCAL_MODEL_URL`을 그 주소(`http://<주소>:<포트>/v1`)로 바꾼다.
- 어느 모델이 답했는지는 LiteLLM 응답 헤더 `x-litellm-model-group`으로 보인다.

## 파이프라인 실행

```
docker compose run --rm pipeline scripts/run-pipeline.ts /app/fixtures/synthetic/drawer.json <정보 입력.json> <치수 규칙.json> /app/data/runs/<이름>
docker compose run --rm pipeline scripts/cases.ts list
```

컨테이너 안에서 저장소 루트는 `/app`이다. `fixtures/`와 `data/`가 같은 이름으로 연결되어 있다.
