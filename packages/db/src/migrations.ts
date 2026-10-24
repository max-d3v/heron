// Ordered schema migrations. `PRAGMA user_version` records how many have run.
// Append new entries; never edit one that has shipped.

export const MIGRATIONS: readonly string[] = [
  /* 1: initial schema */ `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE TABLE skills (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('imported', 'linked')),
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (source, name)
  );

  CREATE TABLE profiles (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('prompt', 'skill')),
    prompt_md TEXT,
    skill_id INTEGER REFERENCES skills(id) ON DELETE SET NULL,
    model TEXT NOT NULL,
    effort TEXT,
    timeout_min INTEGER NOT NULL DEFAULT 20,
    max_turns INTEGER NOT NULL DEFAULT 100,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX profiles_single_default ON profiles(is_default) WHERE is_default = 1;

  CREATE TABLE repos (
    id INTEGER PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('all', 'mine', 'manual')),
    include_drafts INTEGER NOT NULL DEFAULT 0,
    profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
    trust_repo_claude_config INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    etag TEXT,
    initial_sync_done INTEGER NOT NULL DEFAULT 0,
    last_polled_at INTEGER,
    last_poll_error TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (owner, name)
  );

  CREATE TABLE manual_prs (
    repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    PRIMARY KEY (repo_id, number)
  );

  CREATE TABLE prs (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL,
    author_avatar_url TEXT,
    is_draft INTEGER NOT NULL DEFAULT 0,
    head_sha TEXT NOT NULL,
    head_ref TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
    url TEXT NOT NULL,
    additions INTEGER,
    deletions INTEGER,
    changed_files INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    UNIQUE (repo_id, number)
  );
  CREATE INDEX prs_last_activity ON prs(last_activity_at DESC);

  CREATE TABLE reviews (
    id INTEGER PRIMARY KEY,
    pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
    head_sha TEXT NOT NULL,
    state TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    run_after INTEGER,
    attempt INTEGER NOT NULL DEFAULT 0,
    retry_step TEXT,
    last_error TEXT,
    pid INTEGER,
    session_id TEXT,
    profile_snapshot_json TEXT,
    resolved_model TEXT,
    transcript_path TEXT,
    output_json TEXT,
    raw_output TEXT,
    payload_json TEXT,
    github_review_id INTEGER,
    github_review_url TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL
  );
  CREATE INDEX reviews_by_pr ON reviews(pr_id, id DESC);
  CREATE INDEX reviews_by_state ON reviews(state, run_after);

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    pr_id INTEGER REFERENCES prs(id) ON DELETE CASCADE,
    review_id INTEGER REFERENCES reviews(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    data_json TEXT
  );
  CREATE INDEX activity_by_pr ON activity(pr_id, id);
  CREATE INDEX activity_by_review ON activity(review_id, id);
  `,
];
