import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ContentRef { hash: string; size: number; chunks: number }
interface Manifest extends ContentRef { chunkHashes: string[] }

/**
 * 内容寻址的原始字节库。manifest 只在所有块原子落盘后写入；读取者看不见 staging。
 * SQLite 只保存 hash 引用，不承担 GB 级正文。
 */
export class ContentStore {
  constructor(private readonly root: string, private readonly chunkBytes = 1024 * 1024) {}

  async put(bytes: Uint8Array): Promise<ContentRef> {
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
    let manifest: Manifest
    try { manifest = JSON.parse(await readFile(this.manifestPath(hash), 'utf8')) as Manifest } catch { return null }
    if (manifest.hash !== hash || !Array.isArray(manifest.chunkHashes)) throw new Error('ContentStore manifest 损坏')
    const all = Buffer.concat(await Promise.all(manifest.chunkHashes.map(async (chunkHash) => {
      const chunk = await readFile(this.chunkPath(chunkHash))
      if (digest(chunk) !== chunkHash) throw new Error(`ContentStore chunk 校验失败：${chunkHash}`)
      return chunk
    })))
    if (all.byteLength !== manifest.size || digest(all) !== hash) throw new Error(`ContentStore 内容校验失败：${hash}`)
    return all.subarray(Math.max(0, start), end === undefined ? undefined : Math.max(start, end))
  }

  private async getRef(hash: string): Promise<ContentRef> {
    const manifest = JSON.parse(await readFile(this.manifestPath(hash), 'utf8')) as Manifest
    return { hash: manifest.hash, size: manifest.size, chunks: manifest.chunks }
  }
  private chunkPath(hash: string): string { return join(this.root, 'chunks', hash) }
  private manifestPath(hash: string): string { return join(this.root, 'manifests', `${hash}.json`) }
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
async function atomicWrite(path: string, value: Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, value)
  await rename(temporary, path)
}
