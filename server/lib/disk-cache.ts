import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type CacheEnvelope<T> = {
  createdAt: string
  value: T
}

export function buildCacheKey(parts: unknown[]): string {
  const hash = createHash('sha256')

  for (const part of parts) {
    hash.update(typeof part === 'string' ? part : JSON.stringify(part))
    hash.update('\0')
  }

  return hash.digest('hex')
}

export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)

    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function readCachedJson<T>(namespace: string, key: string): Promise<T | null> {
  if (isCacheDisabled()) {
    return null
  }

  try {
    const raw = await readFile(cachePath(namespace, key), 'utf8')
    const envelope = JSON.parse(raw) as CacheEnvelope<T>
    return envelope.value
  } catch {
    return null
  }
}

export async function writeCachedJson<T>(namespace: string, key: string, value: T): Promise<void> {
  if (isCacheDisabled()) {
    return
  }

  const directory = cacheNamespacePath(namespace)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, `${key}.json`),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        value,
      } satisfies CacheEnvelope<T>,
      null,
      2,
    ),
  )
}

function cachePath(namespace: string, key: string): string {
  return join(cacheNamespacePath(namespace), `${key}.json`)
}

function cacheNamespacePath(namespace: string): string {
  return join(cacheRoot(), namespace.replace(/[^a-z0-9-]/gi, '-'))
}

function cacheRoot(): string {
  return process.env.CHAPTERLENS_CACHE_DIR ?? join(process.cwd(), '.chapterlens-cache')
}

function isCacheDisabled(): boolean {
  return process.env.CHAPTERLENS_CACHE_DISABLED === '1'
}
