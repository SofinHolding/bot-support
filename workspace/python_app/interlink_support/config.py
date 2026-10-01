from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", ".env.local"), extra="ignore", case_sensitive=True)

    DATABASE_URL: str = "postgres://support:support@127.0.0.1:5433/support"
    PYTHON_SERVICE_HOST: str = "0.0.0.0"
    PYTHON_SERVICE_PORT: int = 3010
    INTERNAL_SERVICE_TOKEN: str = ""

    # Knowledge extraction/identity: endpoint OpenAI-compatible. Có thể trỏ cùng gateway LLM hiện tại.
    KNOWLEDGE_LLM_BASE_URL: str = ""
    KNOWLEDGE_LLM_API_KEY: str = ""
    KNOWLEDGE_LLM_MODEL: str = ""
    KNOWLEDGE_IDENTITY_MIN_CONFIDENCE: float = Field(default=0.78, ge=0, le=1)
    KNOWLEDGE_DEFAULT_SOURCE_PRIORITY: int = Field(default=50, ge=0, le=1000)
    KNOWLEDGE_MAX_UPLOAD_BYTES: int = 20 * 1024 * 1024
    KNOWLEDGE_SOURCE_DIR: str = "./data/knowledge-sources"

    # RAGFlow là retrieval engine dẫn xuất, không phải source of truth.
    RAGFLOW_ENABLED: bool = False
    RAGFLOW_BASE_URL: str = "http://127.0.0.1:9380"
    RAGFLOW_API_KEY: str = ""
    RAGFLOW_DATASET_ID: str = ""
    RAGFLOW_TIMEOUT_SECONDS: float = 30.0
    RAGFLOW_SIMILARITY_THRESHOLD: float = Field(default=0.2, ge=0, le=1)
    RAGFLOW_VECTOR_WEIGHT: float = Field(default=0.5, ge=0, le=1)
    RAGFLOW_RERANK_ID: str = ""
    RAGFLOW_KEYWORD: bool = True


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
