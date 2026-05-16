-- Run in Supabase SQL Editor (PostgreSQL)
-- Backend uses service_role key; adjust RLS if using anon key from browser.

-- interviews: one row per interview session
CREATE TABLE IF NOT EXISTS interviews (
  session_id UUID PRIMARY KEY,
  user_id TEXT,
  score NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_interviews_user_id ON interviews (user_id);

-- messages: chronological chat turns within a session
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES interviews (session_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_session_created
  ON messages (session_id, created_at DESC);

-- auto-touch interviews.updated_at when a message is inserted
CREATE OR REPLACE FUNCTION touch_interview_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE interviews SET updated_at = now() WHERE session_id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_messages_touch_interview ON messages;
CREATE TRIGGER trg_messages_touch_interview
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION touch_interview_updated_at();

-- Optional: enable RLS and allow service_role full access (dashboard default for server)
-- ALTER TABLE interviews ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
