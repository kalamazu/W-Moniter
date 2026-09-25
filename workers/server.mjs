import { createInterface } from 'node:readline'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const active = new Map()

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function requestOnce(input, signal, redirects = 0) {
  if (redirects > 10) throw new Error('重定向超过 10 次')
  const url = new URL(input.url)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 HTTP(S) 请求')
  const body = Buffer.from(input.bodyBase64 ?? '', 'base64')
  return new Promise((resolve, reject) => {
    const headers = {}
    for (const item of input.headers ?? []) {
      if (input.cookiePolicy === 'omit' && item.name.toLowerCase() === 'cookie') continue
      const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === item.name.toLowerCase()) ?? item.name
      const current = headers[key]
      headers[key] = current === undefined ? item.value : Array.isArray(current) ? [...current, item.value] : [current, item.value]
    }
    if (body.length) headers['Content-Length'] = String(body.length)
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = requestFn(url, { method: input.method, headers, signal }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > 64 * 1024 * 1024) req.destroy(new Error('响应超过 64 MiB 重放上限'))
        else chunks.push(chunk)
      })
      res.on('error', reject)
      res.on('end', async () => {
        const status = res.statusCode ?? 0
        const location = res.headers.location
        if (location && [301, 302, 303, 307, 308].includes(status)) {
          try {
            resolve(await requestOnce({ ...input, url: new URL(location, url).toString(), ...(status === 303 ? { method: 'GET', bodyBase64: '' } : {}) }, signal, redirects + 1))
          } catch (error) { reject(error) }
          return
        }
        resolve({
          status,
          url: url.toString(),
          headers: Object.entries(res.headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).filter(Boolean).map((item) => ({ name, value: String(item) }))),
          bodyBase64: Buffer.concat(chunks).toString('base64'),
          workerPid: process.pid
        })
      })
    })
    req.setTimeout(Math.max(100, Math.min(120_000, input.timeoutMs ?? 30_000)), () => req.destroy(new Error('重放超时')))
    req.on('error', reject)
    if (body.length) req.write(body)
    req.end()
  })
}

async function handle(message) {
  if (message.cancel) {
    active.get(message.cancel)?.abort()
    return
  }
  const controller = new AbortController()
  active.set(message.id, controller)
  try {
    let result
    if (message.method === 'health') result = { pid: process.pid }
    else if (message.method === 'runner.request') result = await requestOnce(message.params, controller.signal)
    else if (message.method === 'index.extract') {
      const bytes = Buffer.from(message.params?.bodyBase64 ?? '', 'base64')
      if (bytes.length > 2 * 1024 * 1024) throw new Error('索引输入超过 2 MiB 上限')
      result = { text: new TextDecoder(message.params?.encoding ?? 'utf-8', { fatal: false }).decode(bytes), workerPid: process.pid }
    } else throw new Error(`未知 Worker 方法：${message.method}`)
    send({ id: message.id, ok: true, result })
  } catch (error) {
    send({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  } finally {
    active.delete(message.id)
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  try { void handle(JSON.parse(line)) } catch (error) { send({ id: null, ok: false, error: String(error) }) }
})

process.stdin.on('end', () => process.exit(0))
