-- Browser sign-in for the CLI (gpushed login): the CLI starts a sign-in, the
-- user approves its short code on the smartloop web app, and the CLI polls
-- with its secret device code until it gets an API token. Rows live 10 minutes.
CREATE TABLE cli_logins (
  device_hash TEXT PRIMARY KEY,           -- sha256 of the CLI's secret device code
  user_code   TEXT NOT NULL UNIQUE,       -- shown in the terminal and the browser, e.g. KQ7M-3XWD
  user_id     TEXT REFERENCES users(id),  -- set when the user approves
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
