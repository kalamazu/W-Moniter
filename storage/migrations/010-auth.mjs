import { createHash } from 'node:crypto'

export const AUTH_VERSION = 10
export const AUTH_CHECKSUM = createHash('sha256').update('010-auth:v1:site_identities:auth_observations:scope').digest('hex')

export function migrateAuth(db) {
  const prior = db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(AUTH_VERSION)
  if (prior) {
    if (prior.checksum !== AUTH_CHECKSUM) throw new Error('schema migration 010 checksum mismatch')
    return
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS site_identities (
      workspace_id TEXT NOT NULL, profile_id TEXT NOT NULL, origin TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'unknown', account_label TEXT,
      source TEXT NOT NULL DEFAULT 'none', observed_at INTEGER NOT NULL,
      verified_at INTEGER, fresh_until INTEGER,
      PRIMARY KEY(workspace_id, profile_id, origin)
    );
    CREATE TABLE IF NOT EXISTS auth_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL, profile_id TEXT NOT NULL, origin TEXT NOT NULL,
      state TEXT NOT NULL, source TEXT NOT NULL, account_label TEXT,
      observed_at INTEGER NOT NULL, detail TEXT,
      FOREIGN KEY(workspace_id, profile_id, origin) REFERENCES site_identities(workspace_id, profile_id, origin)
    );
    CREATE INDEX IF NOT EXISTS ix_auth_scope_time ON auth_observations(workspace_id, profile_id, observed_at);`)
    db.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)').run(AUTH_VERSION, AUTH_CHECKSUM, Date.now())
    db.prepare('INSERT INTO meta(k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run('schema_version', String(AUTH_VERSION))
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
