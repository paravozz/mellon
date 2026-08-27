CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  focus_summary TEXT NOT NULL DEFAULT '',
  focus_updated_at TEXT,
  session_info TEXT NOT NULL DEFAULT '',
  last_seen TEXT,
  deregistered_at TEXT,
  invisible INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages (to_agent, read_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, id);
