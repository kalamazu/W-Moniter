import { createHash } from 'node:crypto'

export const SCOPE_VERSION = 9
const TABLES = ['instances', 'requests', 'cookies', 'site_origins', 'site_snapshots', 'events', 'ws_frames', 'contracts', 'script_refs']
const CHECKSUM_SOURCE = '009-scope:v1:' + TABLES.join(',') + ':body_refs:legacy_inst_seq'
export const SCOPE_CHECKSUM = createHash('sha256').update(CHECKSUM_SOURCE).digest('hex')

function columnExists(db, table, name) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name)
}

export function migrateScope(db, { workspaceId, profileId, adoptLegacy }) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)')
  const prior = db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(SCOPE_VERSION)
  if (prior) {
    if (prior.checksum !== SCOPE_CHECKSUM) throw new Error('schema migration 009 checksum mismatch')
    return
  }
  const existing = ['requests', 'cookies', 'site_origins'].some(table =>
    db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
  if (existing && !adoptLegacy && !columnExists(db, 'requests', 'workspace_id')) {
    throw new Error('unscoped legacy data may only be adopted by default workspace')
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const table of TABLES) {
      if (!columnExists(db, table, 'workspace_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'`)
      if (!columnExists(db, table, 'profile_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'primary'`)
      db.prepare(`UPDATE ${table} SET workspace_id = ?, profile_id = ?`).run(workspaceId, profileId)
    }
    if (!columnExists(db, 'requests', 'legacy_origin')) db.exec("ALTER TABLE requests ADD COLUMN legacy_origin TEXT NOT NULL DEFAULT 'legacy_unknown'")
    db.exec(`CREATE TABLE IF NOT EXISTS body_refs (
      workspace_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      inst INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      hash TEXT NOT NULL,
      PRIMARY KEY (workspace_id, profile_id, inst, seq),
      FOREIGN KEY (inst, seq) REFERENCES requests(inst, seq) ON DELETE CASCADE
    )`)
    db.prepare(`INSERT OR IGNORE INTO body_refs(workspace_id, profile_id, inst, seq, hash)
      SELECT workspace_id, profile_id, inst, seq, body_hash FROM requests WHERE body_hash IS NOT NULL`).run()
    db.exec('CREATE INDEX IF NOT EXISTS ix_requests_scope ON requests(workspace_id, profile_id, inst, seq)')
    db.exec('CREATE INDEX IF NOT EXISTS ix_cookies_scope ON cookies(workspace_id, profile_id, key)')
    db.exec('CREATE INDEX IF NOT EXISTS ix_site_scope ON site_origins(workspace_id, profile_id, origin)')
    db.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)').run(SCOPE_VERSION, SCOPE_CHECKSUM, Date.now())
    db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('schema_version', String(SCOPE_VERSION))
    db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('workspace_id', workspaceId)
    db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('profile_id', profileId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
