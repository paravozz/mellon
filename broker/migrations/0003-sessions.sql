CREATE TABLE IF NOT EXISTS sessions (
  agent_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  session_info TEXT NOT NULL DEFAULT '',
  focus_summary TEXT NOT NULL DEFAULT '',
  focus_updated_at TEXT,
  last_seen TEXT,
  PRIMARY KEY (agent_id, session_key)
);

ALTER TABLE messages ADD COLUMN session_hint TEXT;
ALTER TABLE messages ADD COLUMN from_session TEXT;
