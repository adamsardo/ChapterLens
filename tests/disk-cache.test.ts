import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCacheKey, hashFile, readCachedJson, writeCachedJson } from '../server/lib/disk-cache'

describe('disk cache', () => {
  const originalCacheDir = process.env.CHAPTERLENS_CACHE_DIR
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'chapterlens-cache-test-'))
    process.env.CHAPTERLENS_CACHE_DIR = directory
  })

  afterEach(async () => {
    if (originalCacheDir === undefined) {
      delete process.env.CHAPTERLENS_CACHE_DIR
    } else {
      process.env.CHAPTERLENS_CACHE_DIR = originalCacheDir
    }

    await rm(directory, { recursive: true, force: true })
  })

  it('round-trips JSON values by stable cache key', async () => {
    const key = buildCacheKey(['embedding-v1', 'model', 'text'])
    await writeCachedJson('embeddings', key, [1, 2, 3])

    await expect(readCachedJson<number[]>('embeddings', key)).resolves.toEqual([1, 2, 3])
  })

  it('hashes file content for transcription cache keys', async () => {
    const filePath = join(directory, 'chunk.mp3')
    await writeFile(filePath, 'audio')

    expect(await hashFile(filePath)).toBe(createHash('sha256').update('audio').digest('hex'))
  })
})
