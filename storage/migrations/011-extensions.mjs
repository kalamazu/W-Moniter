import { createHash } from 'node:crypto'

export const EXTENSION_VERSION = 11
export const EXTENSION_CHECKSUM = createHash('sha256').update('011-extensions:v1:desired:observed:coverage:scope').digest('hex')

export function migrateExtensions(db) {
  const prior = db.prepare('SELECT checksum FROM schema_migrations WHERE version=?').get(EXTENSION_VERSION)
  if (prior) {
    if (prior.checksum !== EXTENSION_CHECKSUM) throw new Error('schema migration 011 checksum mismatch')
    return
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`CREATE TABLE extension_desired (
      workspace_id TEXT NOT NULL, profile_id TEXT NOT NULL, extension_id TEXT NOT NULL,
      version TEXT, permissions TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id,profile_id,extension_id)
    );
    CREATE TABLE extension_observed (
      workspace_id TEXT NOT NULL, profile_id TEXT NOT NULL, extension_id TEXT NOT NULL,
      name TEXT, version TEXT, permissions TEXT, enabled INTEGER,
      source TEXT NOT NULL, observed_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id,profile_id,extension_id)
    );
    CREATE TABLE extension_scans (
      workspace_id TEXT NOT NULL, profile_id TEXT NOT NULL,
      source TEXT NOT NULL, complete INTEGER NOT NULL, reason TEXT,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id,profile_id)
    );`)
    db.prepare('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(EXTENSION_VERSION, EXTENSION_CHECKSUM, Date.now())
    db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run('schema_version', String(EXTENSION_VERSION))
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
