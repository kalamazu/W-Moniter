import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ContentRef { hash: string; size: number; chunks: number }
interface Manifest extends ContentRef { chunkHashes: string[] }
export interface ContentIntegrity { hash: string; exists: boolean; valid: boolean; size?: number; chunks?: number; error?: string }
export interface ContentStats { objects: number; bytes: number; chunks: number }

/**
 * 内容寻址的原始字节库。manifest 只在所有块原子落盘后写入；读取者看不见 staging。
 * SQLite 只保存 hash 引用，不承担 GB 级正文。
 */
export class ContentStore {
  private static readonly writes = new Map<string, Promise<unknown>>()
  constructor(private readonly root: string, private readonly chunkBytes = 1024 * 1024) {}

  async put(bytes: Uint8Array): Promise<ContentRef> {
    return this.serializeWrite(() => this.writeContent(bytes))
  }

  private async writeContent(bytes: Uint8Array): Promise<ContentRef> {
    const hash = digest(bytes)
    const manifestPath = this.manifestPath(hash)
    if (existsSync(manifestPath)) return this.getRef(hash)
    await mkdir(join(this.root, 'chunks'), { recursive: true })
    await mkdir(join(this.root, 'manifests'), { recursive: true })
    const chunkHashes: string[] = []
    for (let offset = 0; offset < bytes.byteLength; offset += this.chunkBytes) {
      const chunk = bytes.slice(offset, Math.min(offset + this.chunkBytes, bytes.byteLength))
      const chunkHash = digest(chunk)
      chunkHashes.push(chunkHash)
      const path = this.chunkPath(chunkHash)
      if (!existsSync(path)) await atomicWrite(path, chunk)
    }
    const manifest: Manifest = { hash, size: bytes.byteLength, chunks: chunkHashes.length, chunkHashes }
    await atomicWrite(manifestPath, Buffer.from(JSON.stringify(manifest) + '\n'))
    return { hash, size: manifest.size, chunks: manifest.chunks }
  }

  async get(hash: string, start = 0, end?: number): Promise<Uint8Array | null> {
    const manifest = await this.readManifest(hash)
    if (!manifest) return null
    const stop = end ?? manifest.size
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(stop) || start < 0 || stop < start || stop > manifest.size) {
      throw new RangeError('内容读取范围无效')
    }
    const chunks: Buffer[] = []
    const contentDigest = createHash('sha256')
    let position = 0
    for (const chunkHash of manifest.chunkHashes) {
      const chunk = await readFile(this.chunkPath(chunkHash))
      if (digest(chunk) !== chunkHash) throw new Error(`ContentStore chunk 校验失败：${chunkHash}`)
      contentDigest.update(chunk)
      const next = position + chunk.length
      if (next > start && position < stop) chunks.push(chunk.subarray(Math.max(0, start - position), Math.min(chunk.length, stop - position)))
      position = next
    }
    if (position !== manifest.size) throw new Error(`ContentStore manifest 大小不符：${hash}`)
    if (contentDigest.digest('hex') !== hash) throw new Error(`ContentStore 内容校验失败：${hash}`)
    const result = Buffer.concat(chunks)
    return result
  }

  async verify(hash: string): Promise<ContentIntegrity> {
    if (!/^[a-f0-9]{64}$/.test(hash)) return { hash, exists: false, valid: false, error: 'invalid_hash' }
    try {
      const manifest = await this.readManifest(hash)
      if (!manifest) return { hash, exists: false, valid: false, error: 'content_not_found' }
      await this.get(hash, 0, 0)
      return { hash, exists: true, valid: true, size: manifest.size, chunks: manifest.chunks }
    } catch (error) {
      return { hash, exists: true, valid: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async stats(): Promise<ContentStats> {
    let names: string[]
    try { names = await readdir(join(this.root, 'manifests')) } catch { return { objects: 0, bytes: 0, chunks: 0 } }
    const result = { objects: 0, bytes: 0, chunks: 0 }
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      try {
        const manifest = await this.readManifest(name.slice(0, -5))
        if (!manifest) continue
        result.objects += 1
        result.bytes += manifest.size
        result.chunks += manifest.chunks
      } catch { /* 损坏对象由 verify 给出细节，不混进可用空间统计。 */ }
    }
    return result
  }

  /** 删除 manifest，并在同一写入锁内清理不再被任何 manifest 引用的块。 */
  async revoke(hash: string): Promise<boolean> {
    return this.serializeWrite(async () => {
      const path = this.manifestPath(hash)
      try { await stat(path) } catch { return false }
      await unlink(path)
      await this.collectOrphanChunks()
      return true
    })
  }

  private async collectOrphanChunks(): Promise<void> {
    const referenced = new Set<string>()
    const names = await readdir(join(this.root, 'manifests'))
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      try {
        const manifest = await this.readManifest(name.slice(0, -5))
        for (const chunk of manifest?.chunkHashes ?? []) referenced.add(chunk)
      } catch {
        // 无法证明块未被引用时保守留存，避免误删其它对象。
        return
      }
    }
    let chunks: string[]
    try { chunks = await readdir(join(this.root, 'chunks')) } catch { return }
    for (const chunk of chunks) {
      if (/^[a-f0-9]{64}$/.test(chunk) && !referenced.has(chunk)) await unlink(this.chunkPath(chunk))
    }
  }

  private async serializeWrite<T>(work: () => Promise<T>): Promise<T> {
    const previous = ContentStore.writes.get(this.root) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(work)
    ContentStore.writes.set(this.root, current)
    try { return await current } finally {
      if (ContentStore.writes.get(this.root) === current) ContentStore.writes.delete(this.root)
    }
  }

  private async getRef(hash: string): Promise<ContentRef> {
    const manifest = await this.readManifest(hash)
    if (!manifest) throw new Error(`内容不存在：${hash}`)
    return { hash: manifest.hash, size: manifest.size, chunks: manifest.chunks }
  }
  private async readManifest(hash: string): Promise<Manifest | null> {
    let raw: string
    try { raw = await readFile(this.manifestPath(hash), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const manifest = JSON.parse(raw) as Manifest
    if (manifest.hash !== hash || !Number.isSafeInteger(manifest.size) || manifest.size < 0 || !Array.isArray(manifest.chunkHashes) || manifest.chunkHashes.length !== manifest.chunks || manifest.chunkHashes.some((item) => !/^[a-f0-9]{64}$/.test(item))) {
      throw new Error('ContentStore manifest 损坏')
    }
    return manifest
  }
  private chunkPath(hash: string): string { return join(this.root, 'chunks', hash) }
  private manifestPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('无效的内容 hash')
    return join(this.root, 'manifests', `${hash}.json`)
  }
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
async function atomicWrite(path: string, value: Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, value)
  await rename(temporary, path)
}
