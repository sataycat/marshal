CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  task_slug TEXT NOT NULL,
  branch TEXT NOT NULL,
  descriptor TEXT NOT NULL,
  source_checkout TEXT NOT NULL,
  worktree_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'creating',
  error TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repository_id, task_slug),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE INDEX idx_worktrees_repository_status ON worktrees(repository_id, status, created_at);
CREATE INDEX idx_worktrees_repository_slug ON worktrees(repository_id, task_slug);
