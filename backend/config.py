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

    gemini_api_key: str = ""
    pinecone_api_key: str = ""
    pinecone_index: str = ""
    tavily_api_key: str | None = None
    gemini_model: str = "gemini-2.5-flash"
    gemini_embedding_model: str = "gemini-embedding-001"
    embedding_dimensions: int = 768

    # Optional: comma-separated origins for CORS (default allows local Next.js)
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    @property
    def has_tavily(self) -> bool:
        return bool(self.tavily_api_key and self.tavily_api_key.strip())


def get_settings() -> Settings:
    return Settings()
