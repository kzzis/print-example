import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lot (
  lot_no          TEXT PRIMARY KEY,
  item_code       TEXT NOT NULL,
  item_name       TEXT NOT NULL,
  manufactured_on TEXT NOT NULL,
  expires_on      TEXT,
  quantity        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS print_job (
  id              TEXT PRIMARY KEY,
  lot_no          TEXT NOT NULL REFERENCES lot(lot_no),
  label_count     INTEGER NOT NULL,
  printer         TEXT NOT NULL,
  status          TEXT NOT NULL,
  requested_by    TEXT NOT NULL,
  requested_at    TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  original_job_id TEXT REFERENCES print_job(id),
  reprint_reason  TEXT,
  external_job_id TEXT,
  status_reason   TEXT,
  resolved_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_print_job_status ON print_job(status);
CREATE TABLE IF NOT EXISTS label (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES print_job(id),
  serial       INTEGER NOT NULL,
  total        INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  UNIQUE (job_id, serial)
);
CREATE TABLE IF NOT EXISTS job_event (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL REFERENCES print_job(id),
  at          TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  reason      TEXT
);
`;

/** ":memory:" も指定できる */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

/** 同期トランザクション。fn が例外を投げたら ROLLBACK する */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
