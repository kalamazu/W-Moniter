import type { CookieChangeDetail } from '../../shared/types'

/** A cookie change is only a clue; it cannot produce a verified identity. */
export function cookieClue(change: CookieChangeDetail): { origin: string; state: 'suspected' | 'unknown'; source: 'cookie'; detail: string } | null {
  try {
    const origin = change.url ? new URL(change.url).origin :
      `${change.domain === '127.0.0.1' || change.domain === 'localhost' ? 'http' : 'https'}://${change.domain.replace(/^\./, '')}`
    if (!/^https?:/.test(origin)) return null
    return { origin, state: change.action === 'removed' ? 'unknown' : 'suspected', source: 'cookie', detail: `${change.action}:${change.name}` }
  } catch { return null }
}
