"""LiteLLM 설정(docker/litellm/config.yaml)이 파이프라인이 부르는 모델 이름과 예비 모델 순서를 지키는지 본다(ADR-0015)."""

from pathlib import Path
from typing import Any

import yaml

CONFIG_PATH = Path(__file__).parents[1] / "litellm" / "config.yaml"
config: dict[str, Any] = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
deployments: dict[str, dict[str, Any]] = {m["model_name"]: m["litellm_params"] for m in config["model_list"]}
fallbacks: dict[str, list[str]] = {
    name: targets for entry in config["router_settings"]["fallbacks"] for name, targets in entry.items()
}

# configurator/scripts/run-pipeline.ts의 기본 model_name(LITELLM_MODEL·LITELLM_VLM_MODEL·LITELLM_EMBED_MODEL)
PIPELINE_MODELS = ["llm", "vlm", "embedding"]

# 로컬 모델은 키를 보지 않아 설정에 이 표지를 키로 적는다
LOCAL_KEY = "local"


def is_local(name: str) -> bool:
    return bool(deployments[name].get("api_key") == LOCAL_KEY)


def test_파이프라인이_부르는_모델_이름이_설정에_있다() -> None:
    assert set(PIPELINE_MODELS) <= deployments.keys()


def test_외부_모델은_Groq_다음_로컬_예비_모델로_넘어간다() -> None:
    for name in ["llm", "vlm"]:
        assert deployments[name]["model"].startswith("cerebras/")
        chain = fallbacks[name]
        assert [deployments[t]["model"].split("/")[0] for t in chain[:-1]] == ["groq"]
        assert is_local(chain[-1]), f"{name}의 마지막 예비 모델은 로컬 모델이어야 한다"


def test_임베딩은_예비_모델_없이_로컬에서_돈다() -> None:
    # Cerebras·Groq에 임베딩 API가 없다
    assert is_local("embedding")
    assert "embedding" not in fallbacks


def test_로컬_모델은_환경에서_받은_주소의_OpenAI_호환_API로_부른다() -> None:
    # 운영체제·기종을 가리지 않도록 Ollama 전용 공급자 대신 OpenAI 호환 API로 부른다
    for name, params in deployments.items():
        if is_local(name):
            assert params["model"].startswith("openai/"), name
            assert params["api_base"].startswith("os.environ/"), name


def test_외부_API_키와_프록시_키는_환경에서_읽는다() -> None:
    for name, params in deployments.items():
        if not is_local(name):
            assert params["api_key"].startswith("os.environ/"), name
    assert config["general_settings"]["master_key"].startswith("os.environ/")
