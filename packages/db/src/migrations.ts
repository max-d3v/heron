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
  /* 2: token usage per run */ `
  ALTER TABLE reviews ADD COLUMN usage_json TEXT;
  `,
  /* 3: iterations (§15) */ `
  ALTER TABLE repos ADD COLUMN iteration_mode TEXT NOT NULL DEFAULT 'manual' CHECK (iteration_mode IN ('manual', 'mine', 'all'));
  ALTER TABLE repos ADD COLUMN iteration_profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL;
  ALTER TABLE repos ADD COLUMN iteration_auto_push INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE repos ADD COLUMN iteration_reply INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE repos ADD COLUMN setup_command TEXT;
  ALTER TABLE repos ADD COLUMN local_checkout_path TEXT;
  -- The next poll fetches every open PR again, so head repos and feedback get filled in.
  UPDATE repos SET etag = NULL;

  -- Iteration profiles have no entry; their entry columns keep the old defaults and are ignored.
  ALTER TABLE profiles ADD COLUMN kind TEXT NOT NULL DEFAULT 'review' CHECK (kind IN ('review', 'iteration'));
  DROP INDEX profiles_single_default;
  CREATE UNIQUE INDEX profiles_single_default ON profiles(kind) WHERE is_default = 1;
  INSERT INTO profiles (name, is_default, kind, entry_type, model, effort, timeout_min, max_turns, created_at)
  VALUES ('Default', 1, 'iteration', 'prompt', 'opus', 'high', 30, 150, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

  ALTER TABLE prs ADD COLUMN head_repo TEXT;
  ALTER TABLE prs ADD COLUMN heron_push_streak INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE prs ADD COLUMN feedback_synced_at INTEGER;

  CREATE TABLE iterations (
    id INTEGER PRIMARY KEY,
    pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    head_sha TEXT,
    run_after INTEGER,
    attempt INTEGER NOT NULL DEFAULT 0,
    retry_step TEXT,
    last_error TEXT,
    pid INTEGER,
    session_id TEXT,
    profile_snapshot_json TEXT,
    resolved_model TEXT,
    transcript_path TEXT,
    cwd_kind TEXT CHECK (cwd_kind IN ('worktree', 'local')),
    items_json TEXT,
    output_json TEXT,
    raw_output TEXT,
    commit_sha TEXT,
    triage_total INTEGER NOT NULL DEFAULT 0,
    triage_change INTEGER NOT NULL DEFAULT 0,
    merged_into INTEGER REFERENCES iterations(id) ON DELETE SET NULL,
    usage_json TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL
  );
  CREATE INDEX iterations_by_pr ON iterations(pr_id, id DESC);
  CREATE INDEX iterations_by_state ON iterations(state, run_after);

  CREATE TABLE feedback (
    id INTEGER PRIMARY KEY,
    pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
    github_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('review', 'inline', 'conversation')),
    thread_root_id INTEGER NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    url TEXT,
    path TEXT,
    line INTEGER,
    outdated INTEGER NOT NULL DEFAULT 0,
    diff_hunk TEXT,
    review_state TEXT,
    created_at INTEGER NOT NULL,
    verdict TEXT CHECK (verdict IN ('change', 'no-change')),
    reason TEXT,
    iteration_id INTEGER REFERENCES iterations(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'unhandled' CHECK (status IN ('unhandled', 'handled', 'ignored')),
    handled_at INTEGER,
    observed_at INTEGER NOT NULL,
    UNIQUE (pr_id, kind, github_id)
  );
  CREATE INDEX feedback_by_pr ON feedback(pr_id, status);
  CREATE INDEX feedback_by_iteration ON feedback(iteration_id);

  ALTER TABLE activity ADD COLUMN iteration_id INTEGER REFERENCES iterations(id) ON DELETE CASCADE;
  CREATE INDEX activity_by_iteration ON activity(iteration_id, id);
  `,
  /* 4: reviews and iterations switch on and off separately; reviews start on, iterations off */ `
  ALTER TABLE repos RENAME COLUMN enabled TO review_enabled;
  ALTER TABLE repos ADD COLUMN iteration_enabled INTEGER NOT NULL DEFAULT 0;
  `,
  /* 5: manual scope lists every PR and reviews only on Review now, so nothing is hand-picked any more;
        the local checkout gets its own switch (a path already set stays remembered, switched off) */ `
  DROP TABLE manual_prs;
  ALTER TABLE repos ADD COLUMN use_local_checkout INTEGER NOT NULL DEFAULT 0;
  `,
  /* 6: iteration mode splits in two: whether the agent starts on its own, and whose comments count.
        manual was anyone's comments, waiting for Iterate. The old CHECK and DEFAULT stay ('manual' is
        never written now), so new repos set iteration_comments themselves. */ `
  ALTER TABLE repos ADD COLUMN iteration_auto_start INTEGER NOT NULL DEFAULT 0;
  UPDATE repos SET iteration_auto_start = 1 WHERE iteration_mode != 'manual';
  UPDATE repos SET iteration_mode = 'all' WHERE iteration_mode = 'manual';
  ALTER TABLE repos RENAME COLUMN iteration_mode TO iteration_comments;
  `,
];
