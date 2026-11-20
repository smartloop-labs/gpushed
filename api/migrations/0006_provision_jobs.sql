-- Provisioner runs waiting for or taken by a Cloud Run execution. The API
-- queues one per dispatch and starts an execution; the execution claims the
-- oldest queued job whose box has no job running, so runs of one box happen
-- one at a time, in order (a `down` waits for an `up`).
CREATE TABLE provision_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  box_id      TEXT NOT NULL,
  action      TEXT NOT NULL,             -- up | start | stop | down
  status      TEXT NOT NULL DEFAULT 'queued', -- queued | running | done
  execution   TEXT,                      -- Cloud Run execution that took it
  ok          INTEGER,                   -- exit status was 0 (once done)
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX provision_jobs_status ON provision_jobs (status, box_id);
