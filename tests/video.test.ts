import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { YtDlpVideoService } from '../server/services/video'

describe('video service', () => {
  const originalChunkSeconds = process.env.AUDIO_CHUNK_SECONDS
  const originalStreamingDisabled = process.env.AUDIO_STREAMING_DISABLED
  const originalPollMs = process.env.AUDIO_CHUNK_POLL_MS

  beforeEach(() => {
    process.env.AUDIO_CHUNK_SECONDS = '1200'
    process.env.AUDIO_STREAMING_DISABLED = '1'
    process.env.AUDIO_CHUNK_POLL_MS = '25'
  })

  afterEach(() => {
    if (originalChunkSeconds === undefined) {
      delete process.env.AUDIO_CHUNK_SECONDS
    } else {
      process.env.AUDIO_CHUNK_SECONDS = originalChunkSeconds
    }

    if (originalStreamingDisabled === undefined) {
      delete process.env.AUDIO_STREAMING_DISABLED
    } else {
      process.env.AUDIO_STREAMING_DISABLED = originalStreamingDisabled
    }

    if (originalPollMs === undefined) {
      delete process.env.AUDIO_CHUNK_POLL_MS
    } else {
      process.env.AUDIO_CHUNK_POLL_MS = originalPollMs
    }
  })

  it('returns ffmpeg audio chunks with timeline offsets', async () => {
    const service = new YtDlpVideoService(async (file, args) => {
      if (file === 'yt-dlp') {
        const outputIndex = args.indexOf('--output')
        const outputPath = args[outputIndex + 1].replace('%(ext)s', 'mp3')
        await writeFile(outputPath, 'audio')
      }

      if (file === 'ffmpeg') {
        const chunkTemplate = args[args.length - 1]
        await mkdir(dirname(chunkTemplate), { recursive: true })
        await writeFile(chunkTemplate.replace('%03d', '000'), 'first chunk')
        await writeFile(chunkTemplate.replace('%03d', '001'), 'second chunk')
      }

      return { stdout: '' }
    })

    const audio = await service.extractAudio('https://youtu.be/dQw4w9WgXcQ')

    try {
      expect(audio.chunks).toHaveLength(2)
      expect(audio.chunks.map((chunk) => chunk.startSeconds)).toEqual([0, 1_200])
      expect(audio.chunks.map((chunk) => chunk.index)).toEqual([0, 1])
    } finally {
      await audio.cleanup()
    }
  })

  it('streams yt-dlp into ffmpeg and emits chunks as they close', async () => {
    delete process.env.AUDIO_STREAMING_DISABLED
    process.env.AUDIO_CHUNK_SECONDS = '300'
    const emitted: number[] = []
    const commands: string[] = []
    const service = new YtDlpVideoService(
      async () => ({ stdout: '' }),
      (file, args) => {
        commands.push(`${file} ${args.join(' ')}`)

        if (file === 'yt-dlp') {
          const stdout = new PassThrough()
          queueMicrotask(() => {
            stdout.end('audio bytes')
          })

          return {
            stdout,
            wait: async () => undefined,
            kill: () => undefined,
          }
        }

        const chunkTemplate = args[args.length - 1]
        const stdin = new Writable({
          write(_chunk, _encoding, callback) {
            callback()
          },
        })

        return {
          stdin,
          wait: async () => {
            await mkdir(dirname(chunkTemplate), { recursive: true })
            await writeFile(chunkTemplate.replace('%03d', '000'), 'first chunk')
            await writeFile(chunkTemplate.replace('%03d', '001'), 'second chunk')
          },
          kill: () => undefined,
        }
      },
    )

    const audio = await service.extractAudio('https://youtu.be/dQw4w9WgXcQ', {
      onChunk: (chunk) => emitted.push(chunk.startSeconds),
    })

    try {
      expect(audio.chunks.map((chunk) => chunk.startSeconds)).toEqual([0, 300])
      expect(emitted).toEqual([0, 300])
      expect(commands[0]).toContain('--output -')
      expect(commands[1]).toContain('-ac 1')
      expect(commands[1]).toContain('-ar 16000')
      expect(commands[1]).toContain('-b:a 32k')
    } finally {
      await audio.cleanup()
    }
  })
})
