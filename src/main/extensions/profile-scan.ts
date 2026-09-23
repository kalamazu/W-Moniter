import { readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'

/** Chrome profile is useful evidence, but never a complete live management inventory. */
export async function scanProfileExtensions(profileDir: string, targetUrls: string[] = [], controlledFixtureDir?: string): Promise<{ source: 'profile'; complete: false; reason: string; rows: Array<{ id: string; name: string; version: string | null; permissions: string[] | null; enabled: boolean | null }> }> {
  let reason = 'profile_snapshot_not_complete_management_inventory'
  const rows: Array<{ id: string; name: string; version: string | null; permissions: string[] | null; enabled: boolean | null }> = []
  try {
    const raw = JSON.parse(await readFile(join(profileDir, 'Default', 'Secure Preferences'), 'utf8'))
    const settings = raw?.extensions?.settings
    if (!settings || typeof settings !== 'object') throw new Error('settings unavailable')
    for (const [id, entry] of Object.entries(settings) as Array<[string, Record<string, unknown>]>) {
      if (!/^[a-p]{32}$/.test(id)) continue
      let manifest = entry.manifest as Record<string, unknown> | undefined
      if (!manifest && typeof entry.path === 'string' && isAbsolute(entry.path)) {
        try { manifest = JSON.parse(await readFile(join(entry.path, 'manifest.json'), 'utf8')) } catch { /* version remains unknown */ }
      }
      const active = entry.active_permissions as { api?: string[]; explicit_host?: string[] } | undefined
      rows.push({ id, name: typeof manifest?.name === 'string' ? manifest.name : id,
        version: typeof manifest?.version === 'string' ? manifest.version : null,
        permissions: active ? [...new Set([...(active.api ?? []), ...(active.explicit_host ?? [])])].sort() : null,
        enabled: typeof entry.state === 'number' ? entry.state === 1 : null })
    }
  } catch (error) {
    reason = `profile_unavailable:${error instanceof Error ? error.name : 'unknown'}`
  }
  for (const url of targetUrls) {
    const id = /^chrome-extension:\/\/([a-p]{32})(?:\/|$)/.exec(url)?.[1]
    if (!id || rows.some(row => row.id === id)) continue
    let manifest: Record<string, unknown> | null = null
    if (controlledFixtureDir && url.endsWith('/background.js')) { try { manifest = JSON.parse(await readFile(join(controlledFixtureDir, 'manifest.json'), 'utf8')) } catch {} }
    rows.push({ id, name: typeof manifest?.name === 'string' ? manifest.name : id,
      version: typeof manifest?.version === 'string' ? manifest.version : null,
      permissions: Array.isArray(manifest?.permissions) ? manifest.permissions.map(String).sort() : null, enabled: true })
  }
  return { source: 'profile', complete: false, reason, rows }
}
