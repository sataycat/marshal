CREATE TABLE permission_requests_v4 (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
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
  FOREIGN KEY (repository_id, session_id) REFERENCES acp_sessions(repository_id, id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id, thread_id) REFERENCES chat_threads(repository_id, id) ON DELETE CASCADE
);

INSERT INTO permission_requests_v4
  SELECT id, repository_id, session_id, thread_id, request_id, tool, kind,
         raw_request, options, status, selected_option_id, decision_action,
         diagnostic, created_at, updated_at, resolved_at
    FROM permission_requests;

DROP TABLE permission_requests;
ALTER TABLE permission_requests_v4 RENAME TO permission_requests;

CREATE INDEX idx_permission_requests_repository_thread
  ON permission_requests(repository_id, thread_id);
