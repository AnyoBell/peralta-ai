-- Peralta AI analytics database (Cloudflare D1)
-- Stores anonymous usage events only. Never chat text, names, emails or student IDs.

CREATE TABLE IF NOT EXISTS events (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  aid   TEXT    NOT NULL,          -- random anonymous ID made by the student's browser
  name  TEXT    NOT NULL,          -- event name from the allowlist in src/index.js
  props TEXT    NOT NULL DEFAULT '{}', -- validated JSON, small fixed fields only
  ts    INTEGER NOT NULL           -- unix time in milliseconds
);
CREATE INDEX IF NOT EXISTS events_aid  ON events(aid);
CREATE INDEX IF NOT EXISTS events_ts   ON events(ts);
CREATE INDEX IF NOT EXISTS events_name ON events(name, ts);

-- Daily chat counters for rate limiting. Keys are an anonymous ID or a salted
-- hash of the IP address (never the raw IP). Rows are deleted after 2 days.
CREATE TABLE IF NOT EXISTS limits (
  k   TEXT    PRIMARY KEY,
  n   INTEGER NOT NULL,
  day TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS limits_day ON limits(day);

-- ---------- Optional sign-in with a school email ----------
-- Emails are never stored. ehash is an HMAC of the lowercased email with the EMAIL_KEY secret,
-- so the same student always maps to the same account but a leaked database reveals no addresses.

CREATE TABLE IF NOT EXISTS accounts (
  uid     TEXT    PRIMARY KEY,       -- random account ID
  ehash   TEXT    NOT NULL UNIQUE,   -- HMAC of the school email (not reversible without EMAIL_KEY)
  domain  TEXT    NOT NULL,          -- e.g. cc.peralta.edu (for campus totals)
  nick    TEXT,                      -- public leaderboard nickname, chosen by the student
  created INTEGER NOT NULL,
  last    INTEGER NOT NULL
);

-- Best learning outcomes per account. Score is computed by the server.
CREATE TABLE IF NOT EXISTS progress (
  uid     TEXT    PRIMARY KEY,
  res     TEXT    NOT NULL DEFAULT '{}', -- {"0":{"s":11,"n":12}, ...} best quiz score per module
  xp      INTEGER NOT NULL DEFAULT 0,    -- best game XP
  passed  INTEGER NOT NULL DEFAULT 0,    -- modules passed (0-4)
  score   INTEGER NOT NULL DEFAULT 0,    -- leaderboard points
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS progress_score ON progress(score DESC);

-- Pending sign-in codes (only a hash of the code is kept; expires in 10 minutes)
CREATE TABLE IF NOT EXISTS codes (
  ehash   TEXT    PRIMARY KEY,
  chash   TEXT    NOT NULL,
  expires INTEGER NOT NULL,
  tries   INTEGER NOT NULL DEFAULT 0,
  sent    INTEGER NOT NULL
);

-- Sign-in sessions (only a hash of the token is kept)
CREATE TABLE IF NOT EXISTS sessions (
  thash   TEXT    PRIMARY KEY,
  uid     TEXT    NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid);
