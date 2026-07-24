ALTER TABLE repositories ADD COLUMN registration_status TEXT NOT NULL DEFAULT 'registered';

CREATE INDEX idx_repositories_registration_status ON repositories(registration_status);
