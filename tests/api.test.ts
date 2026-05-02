import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../server/lib/errors'
import { buildApp, type AppServices } from '../server/app'
import type { DependencyStatus, TranscriptSegment } from '../shared/types'

const okDependencies: DependencyStatus[] = [
  { name: 'yt-dlp', ok: true, detail: '2026.01.01' },
  { name: 'ffmpeg', ok: true, detail: '7.0' },
]

const transcriptSegments: TranscriptSegment[] = [
  {
    id: 'segment-1',
    startSeconds: 0,
    endSeconds: 12,
    timestamp: '00:00:00',
    text: 'The introduction frames the video around chapter generation.',
  },
  {
    id: 'segment-2',
    startSeconds: 12,
    endSeconds: 30,
    timestamp: '00:00:12',
    text: 'The speaker explains summaries and transcript based Q&A.',
  },
]

function createFakeServices(overrides: Partial<AppServices> = {}): AppServices {
  return {
    video: {
      checkDependencies: async () => okDependencies,
      assertDependencies: async () => undefined,
      getMetadata: async () => ({
        id: 'dQw4w9WgXcQ',
        title: 'Transcript Intelligence Demo',
        channel: 'ChapterLens',
        durationSeconds: 30,
        webpageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      }),
      getCaptionTranscript: async () => null,
      extractAudio: async (_url, options) => {
        const chunks = [{ path: '/tmp/chunks/chunk-000.mp3', startSeconds: 0, index: 0 }]
        chunks.forEach((chunk) => options?.onChunk?.(chunk))

        return {
          path: '/tmp/audio.mp3',
          chunks,
          cleanup: async () => undefined,
        }
      },
    },
    intelligence: {
      defaults: {
        transcriptionModel: 'gpt-4o-transcribe-diarize',
        textModel: 'gpt-5.5',
        embeddingModel: 'text-embedding-3-small',
      },
      checkConfiguration: () => ({ name: 'openai', ok: true, detail: 'configured' }),
      assertConfigured: () => undefined,
      transcribeAudio: async () => ({
        text: transcriptSegments.map((segment) => segment.text).join(' '),
        segments: transcriptSegments,
      }),
      generatePartialInsights: async () => ({
        summary: 'The video explains transcript-based video intelligence.',
        chapters: [{ timestamp: '00:00:00', title: 'Overview', summary: 'The workflow is introduced.' }],
      }),
      reduceInsights: async () => ({
        summary: 'The video explains how to turn a YouTube transcript into chapters, a concise summary, and Q&A.',
        chapters: [{ timestamp: '00:00:00', title: 'Overview', summary: 'The workflow is introduced.' }],
      }),
      generateInsights: async () => ({
        summary: 'The video explains how to turn a YouTube transcript into chapters, a concise summary, and Q&A.',
        chapters: [{ timestamp: '00:00:00', title: 'Overview', summary: 'The workflow is introduced.' }],
      }),
      embedTexts: async (texts: string[]) => texts.map((_, index) => (index === 0 ? [1, 0] : [0, 1])),
      answerQuestion: async () => ({
        reasoning: 'Reasoning: [00:00:12] states that Q&A is based on transcript context.',
        answer: 'Answer: The Q&A uses transcript retrieval and timestamp citations.',
        citations: [
          {
            timestamp: '00:00:12',
            startSeconds: 12,
            endSeconds: 30,
            text: 'The speaker explains summaries and transcript based Q&A.',
          },
        ],
      }),
    },
    ...overrides,
  }
}

describe('api routes', () => {
  const originalCacheDisabled = process.env.CHAPTERLENS_CACHE_DISABLED
  const originalCacheDir = process.env.CHAPTERLENS_CACHE_DIR

  beforeEach(() => {
    process.env.CHAPTERLENS_CACHE_DISABLED = '1'
  })

  afterEach(() => {
    if (originalCacheDisabled === undefined) {
      delete process.env.CHAPTERLENS_CACHE_DISABLED
    } else {
      process.env.CHAPTERLENS_CACHE_DISABLED = originalCacheDisabled
    }

    if (originalCacheDir === undefined) {
      delete process.env.CHAPTERLENS_CACHE_DIR
    } else {
      process.env.CHAPTERLENS_CACHE_DIR = originalCacheDir
    }
  })

  it('analyzes a valid YouTube URL', async () => {
    const app = buildApp(createFakeServices())
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: {
        url: 'https://youtu.be/dQw4w9WgXcQ',
        features: { summary: true, chapters: true, qa: true },
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      video: { title: 'Transcript Intelligence Demo' },
      summary: expect.any(String),
      qaReady: true,
    })

    await app.close()
  })

  it('uses YouTube captions before audio transcription when captions are available', async () => {
    const events: string[] = []
    const app = buildApp(
      createFakeServices({
        video: {
          ...createFakeServices().video,
          getCaptionTranscript: async () => {
            events.push('captions')
            return {
              text: transcriptSegments.map((segment) => segment.text).join(' '),
              segments: transcriptSegments,
            }
          },
          extractAudio: async () => {
            events.push('audio')
            throw new Error('audio should not run when captions exist')
          },
        },
      }),
    )
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: {
        url: 'https://youtu.be/dQw4w9WgXcQ',
        features: { summary: true, chapters: true, qa: true },
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().transcript.segments).toHaveLength(2)
    expect(events).toEqual(['captions'])

    await app.close()
  })

  it('rejects invalid URLs before video work starts', async () => {
    const app = buildApp(createFakeServices())
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: { url: 'https://example.com/nope' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('INVALID_YOUTUBE_URL')

    await app.close()
  })

  it('reports missing local dependencies', async () => {
    const app = buildApp(
      createFakeServices({
        video: {
          ...createFakeServices().video,
          checkDependencies: async () => [{ name: 'yt-dlp', ok: false, detail: 'missing' }],
          assertDependencies: async () => {
            throw new ApiError(503, 'DEPENDENCY_MISSING', 'Install yt-dlp and ffmpeg before analyzing real YouTube videos.')
          },
        },
      }),
    )
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: { url: 'https://youtu.be/dQw4w9WgXcQ' },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('DEPENDENCY_MISSING')

    await app.close()
  })

  it('keeps Q&A output ordered as reasoning then answer', async () => {
    const app = buildApp(createFakeServices())
    await app.ready()

    const analyze = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: { url: 'https://youtu.be/dQw4w9WgXcQ' },
    })
    const { sessionId } = analyze.json()

    const answer = await app.inject({
      method: 'POST',
      url: '/api/ask',
      payload: { sessionId, question: 'How does Q&A work?' },
    })

    expect(answer.statusCode).toBe(200)
    expect(Object.keys(answer.json()).slice(0, 2)).toEqual(['reasoning', 'answer'])
    expect(answer.json().citations[0].timestamp).toBe('00:00:12')

    await app.close()
  })

  it('runs analysis through a pollable progress job', async () => {
    const app = buildApp(createFakeServices())
    await app.ready()

    const start = await app.inject({
      method: 'POST',
      url: '/api/analyze/jobs',
      payload: {
        url: 'https://youtu.be/dQw4w9WgXcQ',
        features: { summary: true, chapters: true, qa: true },
      },
    })

    expect(start.statusCode).toBe(200)
    const { jobId } = start.json()

    let job = await app.inject({
      method: 'GET',
      url: `/api/analyze/jobs/${jobId}`,
    })

    for (let attempt = 0; attempt < 10 && job.json().status !== 'ready'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      job = await app.inject({
        method: 'GET',
        url: `/api/analyze/jobs/${jobId}`,
      })
    }

    expect(job.statusCode).toBe(200)
    expect(job.json()).toMatchObject({
      status: 'ready',
      label: 'Analysis ready',
      result: {
        qaReady: true,
        summary: expect.any(String),
      },
    })

    await app.close()
  })

  it('starts transcription work while audio extraction is still producing chunks', async () => {
    const events: string[] = []
    const app = buildApp(
      createFakeServices({
        video: {
          ...createFakeServices().video,
          extractAudio: async (_url, options) => {
            const first = { path: '/tmp/chunks/chunk-000.mp3', startSeconds: 0, index: 0 }
            const second = { path: '/tmp/chunks/chunk-001.mp3', startSeconds: 300, index: 1 }

            events.push('extract:start')
            options?.onChunk?.(first)
            await Promise.resolve()
            events.push('extract:middle')
            options?.onChunk?.(second)
            events.push('extract:end')

            return {
              path: '/tmp/audio',
              chunks: [first, second],
              cleanup: async () => undefined,
            }
          },
        },
        intelligence: {
          ...createFakeServices().intelligence,
          transcribeAudio: async (audio) => {
            const chunk = Array.isArray(audio) ? audio[0] : { startSeconds: 0, index: 0 }
            events.push(`transcribe:${chunk.index}`)

            return {
              text: `Transcript chunk ${chunk.index}`,
              segments: [
                {
                  id: `segment-${chunk.index}`,
                  startSeconds: chunk.startSeconds,
                  endSeconds: chunk.startSeconds + 10,
                  timestamp: chunk.index === 0 ? '00:00:00' : '00:05:00',
                  text: `Transcript chunk ${chunk.index}`,
                },
              ],
            }
          },
          embedTexts: async (texts: string[]) => {
            events.push('embed')
            return texts.map((_, index) => [index + 1, 0])
          },
          generatePartialInsights: async () => {
            events.push('partial-insight')
            return {
              summary: 'Partial summary.',
              chapters: [{ timestamp: '00:00:00', title: 'Partial chapter' }],
            }
          },
          reduceInsights: async () => {
            events.push('reduce-insight')
            return {
              summary: 'Final merged summary.',
              chapters: [{ timestamp: '00:00:00', title: 'Merged chapter' }],
            }
          },
        },
      }),
    )
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: {
        url: 'https://youtu.be/dQw4w9WgXcQ',
        features: { summary: true, chapters: true, qa: true },
      },
    })

    expect(response.statusCode).toBe(200)
    expect(events.indexOf('transcribe:0')).toBeGreaterThan(events.indexOf('extract:start'))
    expect(events.indexOf('transcribe:0')).toBeLessThan(events.indexOf('extract:end'))
    expect(events).toContain('embed')
    expect(events).toContain('partial-insight')
    expect(events).toContain('reduce-insight')

    await app.close()
  })

  it('persists analyses, reloads them, answers from the library, and exports presets', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'chapterlens-api-'))
    delete process.env.CHAPTERLENS_CACHE_DISABLED
    process.env.CHAPTERLENS_CACHE_DIR = cacheDir

    try {
      const app = buildApp(createFakeServices())
      await app.ready()

      const analyze = await app.inject({
        method: 'POST',
        url: '/api/analyze',
        payload: {
          url: 'https://youtu.be/dQw4w9WgXcQ',
          features: { summary: true, chapters: true, qa: true },
        },
      })
      const { sessionId } = analyze.json()

      const library = await app.inject({ method: 'GET', url: '/api/analyses' })
      expect(library.statusCode).toBe(200)
      expect(library.json()[0]).toMatchObject({
        sessionId,
        chapterCount: 1,
        transcriptSegmentCount: 2,
      })

      await app.close()

      const restoredApp = buildApp(createFakeServices())
      await restoredApp.ready()

      const record = await restoredApp.inject({
        method: 'GET',
        url: `/api/analyses/${sessionId}`,
      })
      expect(record.statusCode).toBe(200)
      expect(record.json()).toMatchObject({
        sessionId,
        video: { title: 'Transcript Intelligence Demo' },
        transcript: { segments: expect.any(Array) },
      })

      const answer = await restoredApp.inject({
        method: 'POST',
        url: '/api/ask',
        payload: { sessionId, question: 'What does the speaker explain?' },
      })
      expect(answer.statusCode).toBe(200)
      expect(answer.json().citations[0].text).toContain('transcript based Q&A')

      const summaryExport = await restoredApp.inject({
        method: 'GET',
        url: `/api/analyses/${sessionId}/export?preset=summary&format=markdown`,
      })
      expect(summaryExport.statusCode).toBe(200)
      expect(summaryExport.json()).toMatchObject({
        filename: expect.stringMatching(/summary\.md$/),
        mimeType: 'text/markdown; charset=utf-8',
      })
      expect(summaryExport.json().content).toContain('## Summary')
      expect(summaryExport.json().content).not.toContain('## Transcript')

      const transcriptExport = await restoredApp.inject({
        method: 'GET',
        url: `/api/analyses/${sessionId}/export?preset=full-transcript&format=text`,
      })
      expect(transcriptExport.statusCode).toBe(200)
      expect(transcriptExport.json().filename).toMatch(/full-transcript\.txt$/)
      expect(transcriptExport.json().content).toContain('TRANSCRIPT')
      expect(transcriptExport.json().content).toContain('[00:00:12]')

      await restoredApp.close()
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  it('cancels a running analysis job and keeps it cancelled', async () => {
    let releaseMetadata: (() => void) | undefined
    const metadataGate = new Promise<void>((resolve) => {
      releaseMetadata = resolve
    })
    const app = buildApp(
      createFakeServices({
        video: {
          ...createFakeServices().video,
          getMetadata: async () => {
            await metadataGate
            return {
              id: 'dQw4w9WgXcQ',
              title: 'Transcript Intelligence Demo',
              channel: 'ChapterLens',
              durationSeconds: 30,
              webpageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            }
          },
        },
      }),
    )
    await app.ready()

    const start = await app.inject({
      method: 'POST',
      url: '/api/analyze/jobs',
      payload: { url: 'https://youtu.be/dQw4w9WgXcQ' },
    })
    const { jobId } = start.json()

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/analyze/jobs/${jobId}/cancel`,
    })

    expect(cancel.statusCode).toBe(200)
    expect(cancel.json()).toMatchObject({
      status: 'cancelled',
      label: 'Analysis cancelled',
    })

    releaseMetadata?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const job = await app.inject({
      method: 'GET',
      url: `/api/analyze/jobs/${jobId}`,
    })
    expect(job.json().status).toBe('cancelled')

    await app.close()
  })
})
