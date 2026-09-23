import type { JarCookie } from '../browser/site-data'

export interface FixtureVerdict {
  origin: string
  state: 'verified' | 'logged_out' | 'unknown'
  accountLabel: string | null
  detail: string
}

/** Explicit, loopback-only adapter: real sites need their own reviewed verifier. */
export async function verifyFixture(originInput: string, cookies: JarCookie[]): Promise<FixtureVerdict> {
  const url = new URL(originInput)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('主动验证仅支持明确指定的本地受控 fixture origin')
  }
  const cookie = cookies.find(item => item.name === 'auth_session' && item.domain.replace(/^\./, '') === url.hostname)
  try {
    const response = await fetch(new URL('/auth/whoami', url), { headers: cookie ? { cookie: `auth_session=${cookie.value}` } : {},
      redirect: 'manual', signal: AbortSignal.timeout(5000) })
    if (response.status === 200) {
      const json = await response.json() as { account?: string }
      if (typeof json.account === 'string' && json.account) return { origin: url.origin, state: 'verified', accountLabel: json.account, detail: 'fixture_whoami_200' }
    }
    if (response.status === 401) return { origin: url.origin, state: 'logged_out', accountLabel: null, detail: 'fixture_whoami_401' }
    return { origin: url.origin, state: 'unknown', accountLabel: null, detail: `fixture_http_${response.status}` }
  } catch {
    return { origin: url.origin, state: 'unknown', accountLabel: null, detail: 'fixture_timeout_or_network_error' }
  }
}
