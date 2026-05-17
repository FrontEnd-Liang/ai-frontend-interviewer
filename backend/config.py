"""Load env from backend/.env then project-root .env.local (same keys as Next.js)."""

from pathlib import Path

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _BACKEND_DIR.parent

# Later files override earlier ones
load_dotenv(_BACKEND_DIR / ".env")
load_dotenv(_REPO_ROOT / ".env.local")
load_dotenv(_REPO_ROOT / ".env")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(_BACKEND_DIR / ".env", _REPO_ROOT / ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Chat 路由 / 格式化（DeepSeek 官方 API）
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    llm_model: str = "deepseek-chat"

    # Embedding（Pinecone RAG，仍使用 Gemini）
    gemini_api_key: str = ""
    gemini_embedding_model: str = "gemini-embedding-001"
    embedding_dimensions: int = 768

    pinecone_api_key: str = ""
    pinecone_index: str = ""
    tavily_api_key: str | None = None

    # Optional: comma-separated origins for CORS (default allows local Next.js)
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    # Supabase (optional — conversation memory)
    supabase_url: str = ""
    supabase_key: str = ""
    # Max messages loaded into LLM context (~15 rounds = 30 messages)
    memory_max_messages: int = 30

    @property
    def has_tavily(self) -> bool:
        return bool(self.tavily_api_key and self.tavily_api_key.strip())

    @property
    def has_supabase(self) -> bool:
        return bool(self.supabase_url.strip() and self.supabase_key.strip())


def get_settings() -> Settings:
    return Settings()
