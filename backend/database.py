"""
Supabase (PostgreSQL) client singleton and chat memory helpers.
If SUPABASE_URL / SUPABASE_KEY are unset, all operations no-op gracefully.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from threading import Lock
from typing import Any

from supabase import Client, create_client

from config import Settings, get_settings

logger = logging.getLogger(__name__)

# 15 rounds = 30 messages (user + assistant per round)
DEFAULT_MEMORY_MESSAGE_LIMIT = 30


@dataclass(frozen=True)
class HistoryMessage:
    role: str  # "user" | "assistant"
    content: str


class SupabaseDatabase:
    """Thread-safe singleton wrapper around supabase-py Client."""

    _instance: SupabaseDatabase | None = None
    _lock = Lock()

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: Client | None = None
        if settings.has_supabase:
            self._client = create_client(
                settings.supabase_url.strip(),
                settings.supabase_key.strip(),
            )
            logger.info("[database] Supabase client initialized")
        else:
            logger.info("[database] Supabase not configured — memory persistence disabled")

    @classmethod
    def get_instance(cls) -> SupabaseDatabase:
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls(get_settings())
        return cls._instance

    @property
    def enabled(self) -> bool:
        return self._client is not None

    @property
    def client(self) -> Client | None:
        return self._client

    def fetch_recent_messages(
        self,
        session_id: str,
        *,
        limit: int | None = None,
    ) -> list[HistoryMessage]:
        if not self._client or not session_id.strip():
            return []
        cap = limit or self._settings.memory_max_messages
        try:
            resp = (
                self._client.table("messages")
                .select("role, content, created_at")
                .eq("session_id", session_id)
                .order("created_at", desc=True)
                .limit(cap)
                .execute()
            )
            rows: list[dict[str, Any]] = resp.data or []
            rows.reverse()
            out: list[HistoryMessage] = []
            for row in rows:
                role = str(row.get("role", "")).strip()
                content = str(row.get("content", "")).strip()
                if role in ("user", "assistant") and content:
                    out.append(HistoryMessage(role=role, content=content))
            logger.info(
                "[database] loaded %s history message(s) for session %s",
                len(out),
                session_id[:8],
            )
            return out
        except Exception as e:
            logger.warning("[database] fetch_recent_messages failed: %s", e)
            return []

    def ensure_interview(self, session_id: str, user_id: str | None = None) -> None:
        if not self._client or not session_id.strip():
            return
        try:
            existing = (
                self._client.table("interviews")
                .select("session_id")
                .eq("session_id", session_id)
                .limit(1)
                .execute()
            )
            if existing.data:
                if user_id:
                    self._client.table("interviews").update(
                        {"user_id": user_id}
                    ).eq("session_id", session_id).execute()
                return
            row: dict[str, Any] = {"session_id": session_id}
            if user_id:
                row["user_id"] = user_id
            self._client.table("interviews").insert(row).execute()
        except Exception as e:
            logger.warning("[database] ensure_interview failed: %s", e)

    def insert_message(self, session_id: str, role: str, content: str) -> None:
        if not self._client or not session_id.strip() or not content.strip():
            return
        try:
            self._client.table("messages").insert(
                {
                    "session_id": session_id,
                    "role": role,
                    "content": content,
                }
            ).execute()
        except Exception as e:
            logger.warning("[database] insert_message failed: %s", e)

    def persist_turn(
        self,
        session_id: str,
        user_id: str | None,
        user_text: str,
        assistant_payload: dict[str, Any],
    ) -> None:
        """Save one user question + structured assistant answer."""
        if not self.enabled:
            return
        self.ensure_interview(session_id, user_id)
        self.insert_message(session_id, "user", user_text)
        self.insert_message(
            session_id,
            "assistant",
            json.dumps(assistant_payload, ensure_ascii=False),
        )
        logger.info("[database] persisted turn for session %s", session_id[:8])


def get_database() -> SupabaseDatabase:
    return SupabaseDatabase.get_instance()
