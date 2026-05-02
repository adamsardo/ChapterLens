import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import type {
  AnalysisListItem,
  AnalysisRecord,
  AnalyzeJobStartResponse,
  AnalyzeJobStatusResponse,
  AnalyzeResponse,
  AnalyzeStage,
  ApiErrorBody,
  AskResponse,
  DependencyStatus,
  FeatureSet,
  HealthResponse,
  TranscriptSegment,
  VideoMetadata,
} from '../shared/types'
import { formatTimestamp, normalizeTranscriptSegments } from '../shared/time'
import { listAnalysisRecords, readAnalysisRecord, toAnalysisListItem, writeAnalysisRecord } from './lib/analysis-library'
import { buildCacheKey, readCachedJson, writeCachedJson } from './lib/disk-cache'
import { buildAnalysisExport } from './lib/export'
import { buildTranscriptChunks, retrieveRelevantChunks, type TranscriptChunk } from './lib/retrieval'
import { ApiError } from './lib/errors'
import { normalizeYouTubeUrl } from './lib/youtube'
import { OpenAIIntelligenceService, type InsightResult, type IntelligenceService, type TranscriptResult } from './services/openai'
import { YtDlpVideoService, type AudioChunk, type VideoService } from './services/video'

const DEFAULT_FEATURES: FeatureSet = {
  summary: true,
  chapters: true,
  qa: true,
}

const ANALYZE_STAGES: AnalyzeStage[] = ['validating', 'metadata', 'audio', 'transcribing', 'embedding', 'insights']

const AnalyzeRequestSchema = z.object({
  url: z.string().min(1),
  features: z
    .object({
      summary: z.boolean().optional(),
      chapters: z.boolean().optional(),
      qa: z.boolean().optional(),
    })
    .optional(),
})

type AnalyzeRequestBody = z.infer<typeof AnalyzeRequestSchema>

const AskRequestSchema = z.object({
  sessionId: z.string().min(1),
  question: z.string().min(1).max(1_000),
})

const ExportQuerySchema = z.object({
  preset: z.enum(['summary', 'full-transcript']).default('summary'),
  format: z.enum(['markdown', 'text']).default('markdown'),
})

type StoredSession = {
  video: VideoMetadata
  transcriptText: string
  segments: TranscriptSegment[]
  chunks: TranscriptChunk[]
  embeddings: number[][]
  summary?: string
  chapters?: AnalyzeResponse['chapters']
}

type AnalyzeProgressUpdate = {
  stage: AnalyzeStage
  label: string
  detail?: string
}

type AnalyzeJobListener = (job: AnalyzeJobStatusResponse) => void

class AnalysisCancelledError extends Error {
  constructor() {
    super('Analysis cancelled')
    this.name = 'AnalysisCancelledError'
  }
}

export type AppServices = {
  video: VideoService
  intelligence: IntelligenceService
}

export function createServices(): AppServices {
  return {
    video: new YtDlpVideoService(),
    intelligence: new OpenAIIntelligenceService(),
  }
}

export function buildApp(services: AppServices = createServices()): FastifyInstance {
  const app = Fastify({
    logger: false,
  })
  const sessions = new Map<string, StoredSession>()
  const analysisRecords = new Map<string, AnalysisRecord>()
  const analyzeJobs = new Map<string, AnalyzeJobStatusResponse>()
  const jobListeners = new Map<string, Set<AnalyzeJobListener>>()
  const cancelledJobs = new Set<string>()

  void app.register(cors, {
    origin: true,
  })

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      })
    }

    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'The request body does not match the expected shape.',
          details: error.issues,
        },
      })
    }

    const message = error instanceof Error ? error.message : 'Unexpected server error.'

    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message,
      },
    })
  })

  app.get('/api/health', async (): Promise<HealthResponse> => {
    const dependencyStatuses = await services.video.checkDependencies()
    const dependencies: DependencyStatus[] = [...dependencyStatuses, services.intelligence.checkConfiguration()]

    return {
      ok: dependencies.every((dependency) => dependency.ok),
      dependencies,
      defaults: services.intelligence.defaults,
    }
  })

  app.post('/api/analyze/jobs', async (request): Promise<AnalyzeJobStartResponse> => {
    const body = AnalyzeRequestSchema.parse(request.body)
    const jobId = nanoid()
    const job = createAnalyzeJob(jobId)
    analyzeJobs.set(jobId, job)

    void runAnalyze(body, (progress) => {
      throwIfJobCancelled(jobId)
      updateAnalyzeJob(job, progress)
      publishAnalyzeJob(jobId, job)
    })
      .then((result) => {
        if (cancelledJobs.has(jobId)) {
          return
        }

        const updatedAt = new Date().toISOString()
        setAnalyzeJob(jobId, {
          ...job,
          status: 'ready',
          stage: job.stage,
          label: 'Analysis ready',
          detail: `${result.transcript.segments.length} transcript segments processed`,
          activeStep: ANALYZE_STAGES.length,
          updatedAt,
          result,
        })
      })
      .catch((error) => {
        if (cancelledJobs.has(jobId) || isCancellationError(error)) {
          setAnalyzeJob(jobId, {
            ...job,
            status: 'cancelled',
            label: 'Analysis cancelled',
            detail: 'The analysis was stopped before completion',
            updatedAt: new Date().toISOString(),
          })
          return
        }

        const updatedAt = new Date().toISOString()
        setAnalyzeJob(jobId, {
          ...job,
          status: 'error',
          label: 'Analysis failed',
          detail: undefined,
          updatedAt,
          error: toErrorBody(error),
        })
      })

    return { jobId }
  })

  app.get('/api/analyze/jobs/:jobId', async (request): Promise<AnalyzeJobStatusResponse> => {
    const { jobId } = z.object({ jobId: z.string().min(1) }).parse(request.params)
    const job = analyzeJobs.get(jobId)

    if (!job) {
      throw new ApiError(404, 'JOB_NOT_FOUND', 'This analysis job was not found.')
    }

    return job
  })

  app.get('/api/analyze/jobs/:jobId/events', async (request, reply) => {
    const { jobId } = z.object({ jobId: z.string().min(1) }).parse(request.params)
    const job = analyzeJobs.get(jobId)

    if (!job) {
      throw new ApiError(404, 'JOB_NOT_FOUND', 'This analysis job was not found.')
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })

    const send = (nextJob: AnalyzeJobStatusResponse) => {
      reply.raw.write(`data: ${JSON.stringify(nextJob)}\n\n`)
    }
    const listeners = jobListeners.get(jobId) ?? new Set<AnalyzeJobListener>()
    listeners.add(send)
    jobListeners.set(jobId, listeners)
    send(job)

    const heartbeat = setInterval(() => {
      reply.raw.write(': heartbeat\n\n')
    }, 15_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      listeners.delete(send)
      if (listeners.size === 0) {
        jobListeners.delete(jobId)
      }
    })
  })

  app.post('/api/analyze/jobs/:jobId/cancel', async (request): Promise<AnalyzeJobStatusResponse> => {
    const { jobId } = z.object({ jobId: z.string().min(1) }).parse(request.params)
    const job = analyzeJobs.get(jobId)

    if (!job) {
      throw new ApiError(404, 'JOB_NOT_FOUND', 'This analysis job was not found.')
    }

    if (job.status === 'ready' || job.status === 'error' || job.status === 'cancelled') {
      return job
    }

    cancelledJobs.add(jobId)
    return setAnalyzeJob(jobId, {
      ...job,
      status: 'cancelled',
      label: 'Analysis cancelled',
      detail: 'The analysis was stopped before completion',
      updatedAt: new Date().toISOString(),
    })
  })

  app.get('/api/analyses', async (): Promise<AnalysisListItem[]> => {
    const records = await mergeAnalysisRecords()
    return records.map(toAnalysisListItem)
  })

  app.get('/api/analyses/:sessionId/export', async (request) => {
    const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(request.params)
    const query = ExportQuerySchema.parse(request.query)
    const record = await getAnalysisRecordOrThrow(sessionId)
    return buildAnalysisExport(record, query.preset, query.format)
  })

  app.get('/api/analyses/:sessionId', async (request): Promise<AnalysisRecord> => {
    const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(request.params)
    return getAnalysisRecordOrThrow(sessionId)
  })

  app.post('/api/analyze', async (request): Promise<AnalyzeResponse> => {
    const body = AnalyzeRequestSchema.parse(request.body)
    return runAnalyze(body)
  })

  async function mergeAnalysisRecords(): Promise<AnalysisRecord[]> {
    const records = new Map<string, AnalysisRecord>()

    for (const record of await listAnalysisRecords(20)) {
      records.set(record.sessionId, record)
    }

    for (const record of analysisRecords.values()) {
      records.set(record.sessionId, record)
    }

    return [...records.values()]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 12)
  }

  async function getAnalysisRecordOrThrow(sessionId: string): Promise<AnalysisRecord> {
    const record = analysisRecords.get(sessionId) ?? (await readAnalysisRecord(sessionId))

    if (!record) {
      throw new ApiError(404, 'ANALYSIS_NOT_FOUND', 'This analysis was not found in the local library.')
    }

    analysisRecords.set(sessionId, record)
    ensureSessionForRecord(record)
    return record
  }

  function ensureSessionForRecord(record: AnalysisRecord): void {
    if (sessions.has(record.sessionId)) {
      return
    }

    sessions.set(record.sessionId, {
      video: record.video,
      transcriptText: record.transcript.text,
      segments: record.transcript.segments,
      chunks: buildTranscriptChunks(record.transcript.segments),
      embeddings: [],
      summary: record.summary,
      chapters: record.chapters,
    })
  }

  function setAnalyzeJob(jobId: string, job: AnalyzeJobStatusResponse): AnalyzeJobStatusResponse {
    analyzeJobs.set(jobId, job)
    publishAnalyzeJob(jobId, job)
    return job
  }

  function publishAnalyzeJob(jobId: string, job: AnalyzeJobStatusResponse): void {
    for (const listener of jobListeners.get(jobId) ?? []) {
      listener(job)
    }
  }

  function throwIfJobCancelled(jobId: string): void {
    if (cancelledJobs.has(jobId)) {
      throw new AnalysisCancelledError()
    }
  }

  async function runAnalyze(body: AnalyzeRequestBody, onProgress?: (progress: AnalyzeProgressUpdate) => void) {
    const features = normalizeFeatures(body.features)

    if (!features.summary && !features.chapters && !features.qa) {
      throw new ApiError(400, 'FEATURE_REQUIRED', 'Select at least one output: summary, chapters, or Q&A.')
    }

    onProgress?.({
      stage: 'validating',
      label: 'Validating URL',
      detail: 'Checking the YouTube link and local setup',
    })
    const { normalizedUrl } = normalizeYouTubeUrl(body.url)
    await services.video.assertDependencies()
    services.intelligence.assertConfigured()

    onProgress?.({
      stage: 'metadata',
      label: 'Reading video metadata',
      detail: 'Fetching title, channel, duration, and thumbnail',
    })
    const video = await services.video.getMetadata(normalizedUrl)
    const featuresCacheKey = buildTranscriptCacheKey(video, services.intelligence.defaults.transcriptionModel)
    const cachedTranscript = await readCachedJson<{ text: string; segments: TranscriptSegment[] }>(
      'video-transcripts',
      featuresCacheKey,
    )

    if (cachedTranscript) {
      onProgress?.({
        stage: 'embedding',
        label: 'Using cached transcript',
        detail: `${cachedTranscript.segments.length} transcript segments restored from local cache`,
      })
      return finishAnalysis(video, cachedTranscript, features, onProgress)
    }

    onProgress?.({
      stage: 'transcribing',
      label: 'Checking YouTube captions',
      detail: 'Looking for timestamped captions before falling back to audio transcription',
    })
    const captionTranscript = await services.video.getCaptionTranscript(normalizedUrl)

    if (captionTranscript) {
      await writeCachedJson('video-transcripts', featuresCacheKey, captionTranscript)
      onProgress?.({
        stage: 'embedding',
        label: 'Using YouTube captions',
        detail: `${captionTranscript.segments.length} caption segments restored from YouTube`,
      })
      return finishAnalysis(video, captionTranscript, features, onProgress)
    }

    onProgress?.({
      stage: 'audio',
      label: 'Downloading audio',
      detail: 'Streaming YouTube audio into small transcription chunks',
    })
    let audio
    const transcriptionQueue = createTranscriptionQueue({
      services,
      features,
      onProgress,
    })

    try {
      audio = await services.video.extractAudio(normalizedUrl, {
        onChunk: (chunk) => {
          onProgress?.({
            stage: 'transcribing',
            label: 'Transcribing audio',
            detail: `Chunk ${chunk.index + 1} is ready for AI transcription`,
          })
          transcriptionQueue.add(chunk)
        },
        onProgress: (detail) => {
          onProgress?.({
            stage: 'audio',
            label: 'Preparing audio',
            detail,
          })
        },
      })

      if (audio.chunks.length === 0) {
        throw new ApiError(502, 'AUDIO_CHUNKS_EMPTY', 'No audio chunks were produced for this video.')
      }

      transcriptionQueue.finish()
      const pipelineResult = await transcriptionQueue.done()
      const transcript = mergeTranscriptResults(pipelineResult.transcripts)

      await writeCachedJson('video-transcripts', featuresCacheKey, transcript)

      onProgress?.({
        stage: 'insights',
        label: 'Finalizing analysis',
        detail: 'Merging partial insights and transcript retrieval index',
      })
      return finishAnalysis(video, transcript, features, onProgress, pipelineResult)
    } finally {
      transcriptionQueue.finish()
      await audio?.cleanup()
    }
  }

  async function finishAnalysis(
    video: VideoMetadata,
    transcript: { text: string; segments: TranscriptSegment[] },
    features: FeatureSet,
    onProgress?: (progress: AnalyzeProgressUpdate) => void,
    pipelineResult?: TranscriptionPipelineResult,
  ): Promise<AnalyzeResponse> {
    onProgress?.({
      stage: features.qa ? 'embedding' : 'insights',
      label: features.qa ? 'Preparing Q&A' : 'Analyzing transcript',
      detail: features.qa ? 'Building transcript retrieval index' : 'Generating requested summary and chapters',
    })

    const fallbackChunks = buildTranscriptChunks(transcript.segments)
    const embeddingsPromise =
      features.qa && pipelineResult
        ? Promise.all(pipelineResult.embeddingTasks).then((results) => {
            const ready = results.filter((result) => result.chunks.length > 0)
            return ready.length > 0
              ? {
                  chunks: ready.flatMap((result) => result.chunks),
                  embeddings: ready.flatMap((result) => result.embeddings),
                }
              : buildEmbeddingsForChunks(fallbackChunks)
          })
        : features.qa
          ? buildEmbeddingsForChunks(fallbackChunks)
          : Promise.resolve({ chunks: fallbackChunks, embeddings: [] })

    const insightsPromise = getFinalInsights(transcript, features, pipelineResult)

    const [{ chunks, embeddings }, insights] = await Promise.all([embeddingsPromise, insightsPromise])
    const sessionId = nanoid()
    const now = new Date().toISOString()
    const response: AnalyzeResponse = {
      sessionId,
      video,
      transcript: {
        text: transcript.text,
        segments: transcript.segments,
      },
      ...(insights.summary ? { summary: insights.summary } : {}),
      ...(insights.chapters ? { chapters: insights.chapters } : {}),
      qaReady: features.qa,
    }
    const record: AnalysisRecord = {
      ...response,
      createdAt: now,
      updatedAt: now,
      features,
    }

    sessions.set(sessionId, {
      video,
      transcriptText: transcript.text,
      segments: transcript.segments,
      chunks,
      embeddings,
      summary: insights.summary,
      chapters: insights.chapters,
    })
    analysisRecords.set(sessionId, record)
    await writeAnalysisRecord(record)

    return response
  }

  async function buildEmbeddingsForChunks(chunks: TranscriptChunk[]) {
    const texts = chunks.map((chunk) => chunk.embeddingText)

    return {
      chunks,
      embeddings: texts.length ? await services.intelligence.embedTexts(texts) : [],
    }
  }

  async function getFinalInsights(
    transcript: { text: string; segments: TranscriptSegment[] },
    features: FeatureSet,
    pipelineResult?: TranscriptionPipelineResult,
  ): Promise<InsightResult> {
    if (!features.summary && !features.chapters) {
      return {}
    }

    const cacheKey = buildCacheKey([
      'video-final-insights-v2-editorial-chapters',
      services.intelligence.defaults.textModel,
      features,
      transcript.segments.map((segment) => [segment.startSeconds, segment.endSeconds, segment.text]),
    ])
    const cached = await readCachedJson<InsightResult>('video-final-insights', cacheKey)
    if (cached) {
      return cached
    }

    const insights = pipelineResult
      ? await Promise.all(pipelineResult.insightTasks).then((partials) => {
          const usable = partials.filter((partial) => partial.summary || (partial.chapters?.length ?? 0) > 0)
          return usable.length > 0
            ? services.intelligence.reduceInsights(usable, features)
            : services.intelligence.generateInsights(transcript.segments, features)
        })
      : await services.intelligence.generateInsights(transcript.segments, features)

    await writeCachedJson('video-final-insights', cacheKey, insights)
    return insights
  }

  app.post('/api/ask', async (request): Promise<AskResponse> => {
    const body = AskRequestSchema.parse(request.body)
    let session = sessions.get(body.sessionId)

    if (!session) {
      const record = await getAnalysisRecordOrThrow(body.sessionId)
      ensureSessionForRecord(record)
      session = sessions.get(body.sessionId)
    }

    if (!session) {
      throw new ApiError(404, 'SESSION_NOT_FOUND', 'Analyze a video before asking questions about it.')
    }

    services.intelligence.assertConfigured()

    if (session.embeddings.length === 0) {
      session.embeddings = await services.intelligence.embedTexts(session.chunks.map((chunk) => chunk.embeddingText))
    }

    const [questionEmbedding] = await services.intelligence.embedTexts([body.question])
    const contexts = retrieveRelevantChunks(session.chunks, session.embeddings, questionEmbedding)

    if (contexts.length === 0) {
      throw new ApiError(422, 'NO_TRANSCRIPT_CONTEXT', 'No transcript context was available for this question.')
    }

    return services.intelligence.answerQuestion(body.question, contexts)
  })

  registerStaticAssetFallback(app)

  return app
}

type StaticAsset = {
  body: Buffer
  cacheControl: string
  contentType: string
}

function registerStaticAssetFallback(app: FastifyInstance): void {
  const staticDirectory = process.env.STATIC_DIR
  if (!staticDirectory) {
    return
  }

  const staticRoot = resolve(staticDirectory)

  app.setNotFoundHandler(async (request, reply) => {
    const url = new URL(request.url, 'http://chapterlens.local')
    if (url.pathname.startsWith('/api/')) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'This API route was not found.',
        },
      } satisfies ApiErrorBody)
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'This route was not found.',
        },
      } satisfies ApiErrorBody)
    }

    const asset = await readStaticAsset(staticRoot, url.pathname)
    if (!asset) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'The static app has not been built.',
        },
      } satisfies ApiErrorBody)
    }

    reply.header('Cache-Control', asset.cacheControl).type(asset.contentType)
    return request.method === 'HEAD' ? reply.send() : reply.send(asset.body)
  })
}

async function readStaticAsset(staticRoot: string, pathname: string): Promise<StaticAsset | null> {
  const candidatePath = resolveStaticCandidate(staticRoot, pathname)
  const assetPath = candidatePath && extname(candidatePath) ? candidatePath : resolve(staticRoot, 'index.html')
  const body = await readFile(assetPath).catch(() => null)

  if (!body) {
    return null
  }

  return {
    body,
    cacheControl: assetPath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    contentType: getContentType(assetPath),
  }
}

function resolveStaticCandidate(staticRoot: string, pathname: string): string | null {
  let decodedPathname: string
  try {
    decodedPathname = decodeURIComponent(pathname)
  } catch {
    return null
  }

  const candidatePath = resolve(staticRoot, decodedPathname.replace(/^\/+/, ''))
  const relativePath = relative(staticRoot, candidatePath)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null
  }

  return candidatePath
}

function getContentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.css':
      return 'text/css; charset=utf-8'
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.txt':
      return 'text/plain; charset=utf-8'
    case '.webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}

type EmbeddingTaskResult = {
  chunks: TranscriptChunk[]
  embeddings: number[][]
}

type TranscriptionPipelineResult = {
  transcripts: TranscriptResult[]
  embeddingTasks: Array<Promise<EmbeddingTaskResult>>
  insightTasks: Array<Promise<InsightResult>>
}

type TranscriptionQueueOptions = {
  services: AppServices
  features: FeatureSet
  onProgress?: (progress: AnalyzeProgressUpdate) => void
}

function createTranscriptionQueue({ services, features, onProgress }: TranscriptionQueueOptions) {
  const pending: AudioChunk[] = []
  const transcripts: TranscriptResult[] = []
  const embeddingTasks: Array<Promise<EmbeddingTaskResult>> = []
  const insightTasks: Array<Promise<InsightResult>> = []
  const waiters: Array<(result: TranscriptionPipelineResult) => void> = []
  const rejecters: Array<(error: unknown) => void> = []
  const concurrency = getPipelineTranscriptionConcurrency()
  let finished = false
  let active = 0
  let completed = 0
  let cacheHits = 0
  let failure: unknown

  const maybeResolve = () => {
    if (!finished || active > 0 || pending.length > 0 || failure) {
      return
    }

    const result = {
      transcripts: transcripts.sort(firstTranscriptStart),
      embeddingTasks,
      insightTasks,
    }

    for (const waiter of waiters.splice(0)) {
      waiter(result)
    }
  }

  const fail = (error: unknown) => {
    failure = error
    for (const rejecter of rejecters.splice(0)) {
      rejecter(error)
    }
  }

  const pump = () => {
    while (!failure && active < concurrency && pending.length > 0) {
      const chunk = pending.shift()
      if (!chunk) {
        continue
      }

      active += 1
      onProgress?.({
        stage: 'transcribing',
        label: 'Transcribing audio',
        detail: `${completed} chunks done, ${active} active, ${pending.length} queued`,
      })

      void services.intelligence
        .transcribeAudio([chunk], {
          onChunk: (result) => {
            if (result.cacheHit) {
              cacheHits += 1
            }
          },
        })
        .then((transcript) => {
          completed += 1
          transcripts.push(transcript)
          scheduleIncrementalWork(transcript)
          onProgress?.({
            stage: 'transcribing',
            label: 'Transcribing audio',
            detail: `${completed} chunks transcribed, ${active - 1} active, ${pending.length} queued${
              cacheHits > 0 ? `, ${cacheHits} cache hit${cacheHits === 1 ? '' : 's'}` : ''
            }`,
          })
        })
        .catch(fail)
        .finally(() => {
          active -= 1
          pump()
          maybeResolve()
        })
    }
  }

  const scheduleIncrementalWork = (transcript: TranscriptResult) => {
    if (features.qa) {
      const chunks = buildTranscriptChunks(transcript.segments)
      embeddingTasks.push(
        chunks.length > 0
          ? services.intelligence.embedTexts(chunks.map((chunk) => chunk.embeddingText)).then((embeddings) => ({
              chunks,
              embeddings,
            }))
          : Promise.resolve({ chunks: [], embeddings: [] }),
      )
    }

    if (features.summary || features.chapters) {
      insightTasks.push(services.intelligence.generatePartialInsights(transcript.segments, features))
    }
  }

  return {
    add: (chunk: AudioChunk) => {
      if (failure) {
        return
      }

      pending.push(chunk)
      pump()
    },
    finish: () => {
      finished = true
      maybeResolve()
    },
    done: () => {
      if (failure) {
        return Promise.reject(failure)
      }

      if (finished && active === 0 && pending.length === 0) {
        return Promise.resolve({
          transcripts: transcripts.sort(firstTranscriptStart),
          embeddingTasks,
          insightTasks,
        })
      }

      return new Promise<TranscriptionPipelineResult>((resolve, reject) => {
        waiters.push(resolve)
        rejecters.push(reject)
      })
    },
  }
}

function mergeTranscriptResults(transcripts: TranscriptResult[]): TranscriptResult {
  const segments = normalizeTranscriptSegments(transcripts.flatMap((transcript) => transcript.segments))

  if (segments.length === 0) {
    throw new ApiError(502, 'TRANSCRIPTION_EMPTY', 'OpenAI returned an empty transcript for this video.')
  }

  return {
    text: segments.map((segment) => segment.text).join(' '),
    segments: segments.map((segment, index) => ({
      ...segment,
      id: segment.id || `segment-${index + 1}`,
      timestamp: segment.timestamp || formatTimestamp(segment.startSeconds),
    })),
  }
}

function firstTranscriptStart(a: TranscriptResult, b: TranscriptResult): number {
  return (a.segments[0]?.startSeconds ?? 0) - (b.segments[0]?.startSeconds ?? 0)
}

function buildTranscriptCacheKey(video: VideoMetadata, transcriptionModel: string): string {
  return buildCacheKey([
    'video-transcript-v1',
    video.id,
    video.durationSeconds ?? 'unknown-duration',
    transcriptionModel,
    process.env.AUDIO_CHUNK_SECONDS ?? 'default-chunks',
    process.env.AUDIO_BITRATE ?? '32k',
    process.env.AUDIO_SAMPLE_RATE ?? '16000',
  ])
}

function getPipelineTranscriptionConcurrency(): number {
  const configured = Number(process.env.TRANSCRIPTION_CONCURRENCY)

  if (!Number.isFinite(configured) || configured <= 0) {
    return 4
  }

  return Math.min(Math.max(Math.floor(configured), 1), 8)
}

function createAnalyzeJob(jobId: string): AnalyzeJobStatusResponse {
  const now = new Date().toISOString()

  return {
    jobId,
    status: 'queued',
    stage: 'queued',
    label: 'Queued',
    detail: 'Waiting for the API to start',
    activeStep: 0,
    totalSteps: ANALYZE_STAGES.length,
    startedAt: now,
    updatedAt: now,
  }
}

function updateAnalyzeJob(job: AnalyzeJobStatusResponse, progress: AnalyzeProgressUpdate): void {
  job.status = 'running'
  job.stage = progress.stage
  job.label = progress.label
  job.detail = progress.detail
  job.activeStep = stageIndex(progress.stage)
  job.updatedAt = new Date().toISOString()
}

function stageIndex(stage: AnalyzeStage): number {
  const index = ANALYZE_STAGES.indexOf(stage)
  return index >= 0 ? index + 1 : 0
}

function normalizeFeatures(features?: Partial<FeatureSet>): FeatureSet {
  return {
    summary: features?.summary ?? DEFAULT_FEATURES.summary,
    chapters: features?.chapters ?? DEFAULT_FEATURES.chapters,
    qa: features?.qa ?? DEFAULT_FEATURES.qa,
  }
}

function isCancellationError(error: unknown): boolean {
  return error instanceof AnalysisCancelledError
}

function toErrorBody(error: unknown): ApiErrorBody['error'] {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    }
  }

  if (error instanceof z.ZodError) {
    return {
      code: 'BAD_REQUEST',
      message: 'The request body does not match the expected shape.',
      details: error.issues,
    }
  }

  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'Unexpected server error.',
  }
}
