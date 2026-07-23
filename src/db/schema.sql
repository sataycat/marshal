CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'backlog',
  spec_markdown TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_failure TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_slug ON tasks(slug);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  prompt TEXT,
  commit_sha TEXT,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME,
  error TEXT,
  agent_version TEXT NOT NULL DEFAULT 'legacy',
  capabilities TEXT NOT NULL DEFAULT '{}',
  assignment_config TEXT NOT NULL DEFAULT '{}',
  supervisor_session_id TEXT,
  operation_id TEXT,
  verification_status TEXT,
  verification_output TEXT,
  failure TEXT,
  auth_recovery_resolved_at DATETIME,
  superseded_by_run_id INTEGER,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS run_operations (
  id TEXT PRIMARY KEY,
  run_id INTEGER NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  diagnostic TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id, seq);

CREATE TABLE IF NOT EXISTS spec_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  prompt_status TEXT,
  failure TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_spec_messages_task_id
  ON spec_messages(task_id, created_at, id);

CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  repository_id TEXT,
  repo_root TEXT NOT NULL,
  cwd TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_version TEXT NOT NULL DEFAULT 'legacy',
  title TEXT NOT NULL DEFAULT 'New thread',
  status TEXT NOT NULL DEFAULT 'draft',
  archived INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  task_slug TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_message_at DATETIME,
  scratch_markdown TEXT NOT NULL DEFAULT '',
  agent_provenance TEXT NOT NULL DEFAULT '{}',
  session_config_options TEXT NOT NULL DEFAULT '[]',
  session_modes TEXT,
  session_initialized INTEGER NOT NULL DEFAULT 0,
  failure TEXT,
  FOREIGN KEY (task_slug) REFERENCES tasks(slug)
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_repo_activity
  ON chat_threads(repo_root, archived, pinned, last_message_at, updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  attachment_ids TEXT NOT NULL DEFAULT '[]',
  prompt_status TEXT,
  failure TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_id
  ON chat_messages(thread_id, id);

CREATE TABLE IF NOT EXISTS chat_attachments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  storage_name TEXT NOT NULL UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_attachments_thread_id
  ON chat_attachments(thread_id, created_at, id);

CREATE TABLE IF NOT EXISTS acp_sessions (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  acp_session_id TEXT,
  capabilities TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'starting',
  recovery_metadata TEXT NOT NULL DEFAULT '{}',
  diagnostic TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  ended_at DATETIME,
  agent_provenance TEXT NOT NULL DEFAULT '{}'
  ,failure TEXT
);
CREATE INDEX IF NOT EXISTS idx_acp_sessions_owner ON acp_sessions(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS acp_prompts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  cancellation_requested_at DATETIME,
  diagnostic TEXT,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME,
  content TEXT NOT NULL DEFAULT '{}',
  failure TEXT,
  message_id INTEGER,
  resubmission_of TEXT,
  FOREIGN KEY (session_id) REFERENCES acp_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_acp_prompts_session ON acp_prompts(session_id, started_at);

CREATE TABLE IF NOT EXISTS acp_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  prompt_id TEXT,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  normalized TEXT NOT NULL,
  raw_payload TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES acp_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (prompt_id) REFERENCES acp_prompts(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_acp_events_sequence ON acp_events(session_id, seq);

CREATE TABLE IF NOT EXISTS permission_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  kind TEXT,
  raw_request TEXT NOT NULL,
  options TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  selected_option_id TEXT,
  decision_action TEXT,
  diagnostic TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME,
  FOREIGN KEY (session_id) REFERENCES acp_sessions(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_requests_session_request ON permission_requests(session_id, request_id);
CREATE INDEX IF NOT EXISTS idx_permission_requests_thread_status ON permission_requests(thread_id, status, created_at);

CREATE TABLE IF NOT EXISTS spec_author_sessions (
  id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL,
  repository_id TEXT NOT NULL,
  workflow_profile_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '{}',
  assignment_config TEXT NOT NULL DEFAULT '{}',
  acp_session_id TEXT,
  supervisor_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  agent_provenance TEXT NOT NULL DEFAULT '{}',
  failure TEXT,
  message_id INTEGER,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS idx_spec_author_sessions_task ON spec_author_sessions(task_id, created_at);

CREATE TABLE IF NOT EXISTS spec_author_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_session_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  diagnostic TEXT,
  failure TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (author_session_id) REFERENCES spec_author_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_spec_author_operations_session ON spec_author_operations(author_session_id, id);
