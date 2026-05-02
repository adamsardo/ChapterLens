import { createReadStream } from 'node:fs'
import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import type { AskResponse, Chapter, Citation, DependencyStatus, FeatureSet, TranscriptSegment } from '../../shared/types'
import { enforceSummaryLimit, formatTimestamp, normalizeEditorialChapters, normalizeTranscriptSegments, parseTimestamp } from '../../shared/time'
import { buildCacheKey, hashFile, readCachedJson, writeCachedJson } from '../lib/disk-cache'
import { ApiError } from '../lib/errors'
import type { TranscriptChunk } from '../lib/retrieval'

const InsightsSchema = z.object({
  summary: z.string().nullable(),
  chapters: z.array(
    z.object({
      start_seconds: z.number().nonnegative(),
      title: z.string(),
      summary: z.string().nullable(),
    }),
  ),
})

const AnswerSchema = z.object({
  reasoning: z.string(),
  answer: z.string(),
  citations: z.array(
    z.object({
      timestamp: z.string(),
      start_seconds: z.number().nonnegative(),
      end_seconds: z.number().nonnegative(),
      text: z.string(),
    }),
  ),
})

const CHAPTER_STYLE_INSTRUCTIONS = [
  'Chapter style must match premium podcast show notes, not a dense transcript outline.',
  'Use short Title Case labels, usually 3-7 words, with no trailing period.',
  'Prefer topic and segment names: "Elon vs OpenAI Overview", "Jury Selection Drama", "Microsoft and OpenAI Split", "Steam Controller Deep Dive".',
  'Do not write explanatory sentence titles like "The hosts discuss..." or "The excerpt covers...".',
  'Return chapter summary as null unless explicitly asked otherwise.',
  'Avoid micro-chapters for every joke, quote, rebuttal, or courtroom exchange.',
  'For long shows, target roughly one chapter every 2-3 minutes, with occasional closer chapters only for rapid-fire major topic changes.',
].join(' ')

export type TranscriptResult = {
  text: string
  segments: TranscriptSegment[]
}

export type AudioTranscriptSource =
  | string
  | Array<{
      path: string
      startSeconds: number
      index?: number
    }>

export type TranscriptionProgress = {
  completed: number
  total: number
  active: number
  chunkIndex?: number
  cacheHits?: number
}

export type ChunkTranscriptionResult = {
  chunk: Exclude<AudioTranscriptSource, string>[number]
  response: DiarizedTranscription
  cacheHit: boolean
}

export type TranscriptionOptions = {
  onProgress?: (progress: TranscriptionProgress) => void
  onChunk?: (result: ChunkTranscriptionResult) => void
}

export type InsightResult = {
  summary?: string
  chapters?: Chapter[]
}

export type IntelligenceService = {
  defaults: {
    transcriptionModel: string
    textModel: string
    embeddingModel: string
  }
  checkConfiguration: () => DependencyStatus
  assertConfigured: () => void
  transcribeAudio: (audio: AudioTranscriptSource, options?: TranscriptionOptions) => Promise<TranscriptResult>
  generatePartialInsights: (segments: TranscriptSegment[], features: FeatureSet) => Promise<InsightResult>
  reduceInsights: (partials: InsightResult[], features: FeatureSet) => Promise<InsightResult>
  generateInsights: (segments: TranscriptSegment[], features: FeatureSet) => Promise<InsightResult>
  embedTexts: (texts: string[]) => Promise<number[][]>
  answerQuestion: (question: string, contexts: TranscriptChunk[]) => Promise<AskResponse>
}

type DiarizedSegment = {
  id?: string
  start: number
  end: number
  speaker?: string
  text: string
}

export type DiarizedTranscription = {
  text?: string
  segments?: DiarizedSegment[]
}

export class OpenAIIntelligenceService implements IntelligenceService {
  readonly defaults: IntelligenceService['defaults']
  private readonly apiKey?: string
  private client?: OpenAI

  constructor(options: { apiKey?: string } = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
    this.defaults = {
      transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL ?? 'gpt-4o-transcribe-diarize',
      textModel: process.env.OPENAI_TEXT_MODEL ?? 'gpt-5.5',
      embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    }
  }

  checkConfiguration(): DependencyStatus {
    return {
      name: 'openai',
      ok: Boolean(this.apiKey),
      detail: this.apiKey ? 'OPENAI_API_KEY is configured' : 'OPENAI_API_KEY is not set',
    }
  }

  assertConfigured(): void {
    if (!this.apiKey) {
      throw new ApiError(503, 'OPENAI_KEY_MISSING', 'Set OPENAI_API_KEY before analyzing videos.')
    }
  }

  async transcribeAudio(audio: AudioTranscriptSource, options: TranscriptionOptions = {}): Promise<TranscriptResult> {
    const client = this.getClient()
    const chunks = normalizeAudioSource(audio)
    const transcriptionModel = this.defaults.transcriptionModel
    const transcriptions = new Array<{
      response: DiarizedTranscription
      startSeconds: number
      index?: number
    }>(chunks.length)
    const concurrency = Math.min(getTranscriptionConcurrency(), chunks.length)
    let nextIndex = 0
    let active = 0
    let completed = 0
    let cacheHits = 0

    options.onProgress?.({ completed, total: chunks.length, active, cacheHits })

    async function transcribeNext(): Promise<void> {
      const index = nextIndex
      nextIndex += 1

      if (index >= chunks.length) {
        return
      }

      const chunk = chunks[index]
      active += 1
      options.onProgress?.({ completed, total: chunks.length, active, chunkIndex: chunk.index ?? index })

      const cacheKey = await transcriptionCacheKey(chunk.path, transcriptionModel)
      const cached = await readCachedJson<DiarizedTranscription>('transcriptions', cacheKey)
      const response =
        cached ??
        ((await client.audio.transcriptions.create(
          {
            file: createReadStream(chunk.path),
            model: transcriptionModel,
            response_format: 'diarized_json',
            chunking_strategy: 'auto',
          },
          { timeout: getOpenAITimeout('OPENAI_TRANSCRIPTION_TIMEOUT_MS', 600_000) },
        )) as DiarizedTranscription)

      if (cached) {
        cacheHits += 1
      } else {
        await writeCachedJson('transcriptions', cacheKey, response)
      }

      transcriptions[index] = {
        response,
        startSeconds: chunk.startSeconds,
        index: chunk.index,
      }
      options.onChunk?.({ chunk, response, cacheHit: Boolean(cached) })
      active -= 1
      completed += 1
      options.onProgress?.({ completed, total: chunks.length, active, chunkIndex: chunk.index ?? index, cacheHits })

      await transcribeNext()
    }

    await Promise.all(Array.from({ length: concurrency }, () => transcribeNext()))

    return mergeDiarizedTranscriptions(transcriptions)
  }

  async generatePartialInsights(segments: TranscriptSegment[], features: FeatureSet): Promise<InsightResult> {
    if (!features.summary && !features.chapters) {
      return {}
    }

    const parsed = await this.createInsights(
      'partial-insights',
      [
        'partial-insights-v2-editorial-chapters',
        this.defaults.textModel,
        features,
        segments.map((segment) => [segment.startSeconds, segment.endSeconds, segment.text]),
      ],
      `You analyze one excerpt from a YouTube transcript. Return concise partial insights only from this excerpt. Chapter timestamps must match the excerpt evidence. ${CHAPTER_STYLE_INSTRUCTIONS}`,
      `Create partial ${
        features.summary && features.chapters
          ? 'summary and chapter candidates'
          : features.summary
            ? 'summary'
            : 'chapter candidates'
      } for this transcript excerpt.\n\n${partialChapterGuidance(segments)}\n\nTranscript excerpt:\n${transcriptForPrompt(segments)}`,
    )

    return insightsFromParsed(parsed, features)
  }

  async reduceInsights(partials: InsightResult[], features: FeatureSet): Promise<InsightResult> {
    if (!features.summary && !features.chapters) {
      return {}
    }

    const usablePartials = partials.filter((partial) => partial.summary || (partial.chapters?.length ?? 0) > 0)
    if (usablePartials.length === 0) {
      return {}
    }

    const parsed = await this.createInsights(
      'reduced-insights',
      ['reduced-insights-v2-editorial-chapters', this.defaults.textModel, features, usablePartials],
      `You merge partial YouTube transcript insights into final user-facing output. Keep the final summary under 200 words. Preserve chapter timestamps from candidates and output chapters in order. ${CHAPTER_STYLE_INSTRUCTIONS}`,
      `Merge these partial insights into final ${
        features.summary && features.chapters ? 'summary and chapters' : features.summary ? 'summary' : 'chapters'
      }.\n\n${reducedChapterGuidance(usablePartials)}\n\nPartial insights:\n${partialsForPrompt(usablePartials)}`,
    )

    return insightsFromParsed(parsed, features)
  }

  async generateInsights(segments: TranscriptSegment[], features: FeatureSet): Promise<InsightResult> {
    if (!features.summary && !features.chapters) {
      return {}
    }

    const transcript = transcriptForPrompt(segments)
    const requested = [
      features.summary ? 'a clear summary under 200 words' : null,
      features.chapters ? 'timestamped chapters with descriptive titles' : null,
    ]
      .filter(Boolean)
      .join(' and ')

    const parsed = await this.createInsights(
      'full-insights',
      ['full-insights-v2-editorial-chapters', this.defaults.textModel, features, transcript],
      `You analyze YouTube transcripts. Return only the requested fields. Keep summaries factual and concise. Chapter timestamps must match the transcript evidence. ${CHAPTER_STYLE_INSTRUCTIONS}`,
      `Create ${requested} for this transcript.\n\n${finalChapterGuidance(segments)}\n\nTranscript:\n${transcript}`,
    )

    return insightsFromParsed(parsed, features)
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return []
    }

    const client = this.getClient()
    const embeddings = new Array<number[]>(texts.length)
    const misses: Array<{ text: string; index: number; key: string }> = []

    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index]
      const key = buildCacheKey(['embedding-v1', this.defaults.embeddingModel, text])
      const cached = await readCachedJson<number[]>('embeddings', key)

      if (cached) {
        embeddings[index] = cached
      } else {
        misses.push({ text, index, key })
      }
    }

    if (misses.length > 0) {
      const response = await client.embeddings.create(
        {
          model: this.defaults.embeddingModel,
          input: misses.map((miss) => miss.text),
        },
        { timeout: getOpenAITimeout('OPENAI_EMBEDDING_TIMEOUT_MS', 120_000) },
      )

      for (const item of response.data.sort((a, b) => a.index - b.index)) {
        const miss = misses[item.index]
        embeddings[miss.index] = item.embedding
        await writeCachedJson('embeddings', miss.key, item.embedding)
      }
    }

    return embeddings
  }

  async answerQuestion(question: string, contexts: TranscriptChunk[]): Promise<AskResponse> {
    const client = this.getClient()
    const contextText = contexts
      .map((context, index) => {
        return `Context ${index + 1}: ${context.timestamp}-${formatTimestamp(context.endSeconds)}\n${context.text}`
      })
      .join('\n\n')

    const response = await client.responses.parse(
      {
        model: this.defaults.textModel,
        instructions:
          'Answer questions using only the supplied transcript context. The reasoning field must be a concise evidence-based explanation with timestamp citations, not hidden chain-of-thought. Put the direct conclusion only in the answer field.',
        input: `Question: ${question}\n\nRelevant transcript context:\n${contextText}`,
        text: {
          format: zodTextFormat(AnswerSchema, 'video_question_answer'),
        },
      },
      { timeout: getOpenAITimeout('OPENAI_TEXT_TIMEOUT_MS', 360_000) },
    )

    const parsed = response.output_parsed
    if (!parsed) {
      throw new ApiError(502, 'ANSWER_EMPTY', 'OpenAI did not return a structured answer.')
    }

    const citations = parsed.citations.map(toCitation)

    return {
      reasoning: parsed.reasoning.trim(),
      answer: parsed.answer.trim(),
      citations: citations.length > 0 ? citations : contexts.slice(0, 3).map(toChunkCitation),
    }
  }

  private getClient(): OpenAI {
    this.assertConfigured()
    this.client ??= new OpenAI({ apiKey: this.apiKey })
    return this.client
  }

  private async createInsights(
    namespace: string,
    cacheParts: unknown[],
    instructions: string,
    input: string,
  ): Promise<z.infer<typeof InsightsSchema>> {
    const cacheKey = buildCacheKey(cacheParts)
    const cached = await readCachedJson<z.infer<typeof InsightsSchema>>(namespace, cacheKey)
    if (cached) {
      return cached
    }

    const client = this.getClient()
    const response = await client.responses.parse(
      {
        model: this.defaults.textModel,
        instructions,
        input,
        text: {
          format: zodTextFormat(InsightsSchema, 'video_insights'),
        },
      },
      { timeout: getOpenAITimeout('OPENAI_TEXT_TIMEOUT_MS', 360_000) },
    )

    const parsed = response.output_parsed
    if (!parsed) {
      throw new ApiError(502, 'INSIGHTS_EMPTY', 'OpenAI did not return structured video insights.')
    }

    await writeCachedJson(namespace, cacheKey, parsed)
    return parsed
  }
}

export function mergeDiarizedTranscriptions(
  chunks: Array<{
    response: DiarizedTranscription
    startSeconds: number
    index?: number
  }>,
): TranscriptResult {
  const textParts: string[] = []
  const mappedSegments: TranscriptSegment[] = []

  chunks.forEach((chunk, chunkIndex) => {
    const offset = toFiniteSeconds(chunk.startSeconds)
    const chunkLabel = chunk.index ?? chunkIndex
    const text = chunk.response.text?.trim() ?? ''
    const rawSegments = chunk.response.segments ?? []

    if (text) {
      textParts.push(text)
    }

    if (rawSegments.length === 0 && text) {
      mappedSegments.push({
        id: `chunk-${chunkLabel + 1}-segment-1`,
        startSeconds: offset,
        endSeconds: offset,
        timestamp: formatTimestamp(offset),
        text,
      })
      return
    }

    rawSegments.forEach((segment, segmentIndex) => {
      const startSeconds = offset + toFiniteSeconds(segment.start)
      const endSeconds = offset + Math.max(toFiniteSeconds(segment.start), toFiniteSeconds(segment.end))

      mappedSegments.push({
        id: segment.id ?? `chunk-${chunkLabel + 1}-segment-${segmentIndex + 1}`,
        startSeconds,
        endSeconds,
        timestamp: formatTimestamp(startSeconds),
        text: segment.text,
        speaker: segment.speaker,
      })
    })
  })

  const segments = normalizeTranscriptSegments(mappedSegments)

  if (segments.length === 0) {
    throw new ApiError(502, 'TRANSCRIPTION_EMPTY', 'OpenAI returned an empty transcript for this video.')
  }

  return {
    text: textParts.join(' ').trim() || segments.map((segment) => segment.text).join(' '),
    segments,
  }
}

function transcriptForPrompt(segments: TranscriptSegment[]): string {
  return segments.map((segment) => `[${segment.timestamp}] ${segment.text}`).join('\n')
}

function partialsForPrompt(partials: InsightResult[]): string {
  return partials
    .map((partial, index) => {
      const summary = partial.summary ? `Summary: ${partial.summary}` : 'Summary: none'
      const chapters =
        partial.chapters?.map((chapter) => {
          return `[${chapter.timestamp}] ${chapter.title}${chapter.summary ? ` - ${chapter.summary}` : ''}`
        }) ?? []

      return `Part ${index + 1}\n${summary}\nChapters:\n${chapters.length > 0 ? chapters.join('\n') : 'none'}`
    })
    .join('\n\n')
}

function partialChapterGuidance(segments: TranscriptSegment[]): string {
  const durationSeconds = transcriptDurationSeconds(segments)
  const minutes = Math.max(1, Math.round(durationSeconds / 60))

  return [
    `This excerpt is about ${minutes} minute${minutes === 1 ? '' : 's'} long.`,
    'If chapters are requested, return 1-3 chapter candidates for a five-minute excerpt, usually 1-2.',
    'Return 0 candidates if the excerpt is a continuation of the same topic and no meaningful show-note boundary begins here.',
  ].join(' ')
}

function reducedChapterGuidance(partials: InsightResult[]): string {
  const lastTimestamp = Math.max(
    0,
    ...partials.flatMap((partial) => partial.chapters?.map((chapter) => parseTimestamp(chapter.timestamp)) ?? []),
  )
  const target = targetChapterCount(lastTimestamp)

  return [
    `If chapters are requested, aim for about ${target} final chapters for this show, plus or minus 15 percent.`,
    'Drop near-duplicate or overly granular candidates.',
    'Prefer the most editorially useful boundary when several candidates occur within the same minute.',
    'Output title-only chapters by setting chapter summaries to null.',
  ].join(' ')
}

function finalChapterGuidance(segments: TranscriptSegment[]): string {
  const durationSeconds = transcriptDurationSeconds(segments)
  const target = targetChapterCount(durationSeconds)

  return [
    `If chapters are requested, aim for about ${target} chapters, plus or minus 15 percent.`,
    'This should feel like a polished YouTube/podcast chapter list, not a detailed transcript outline.',
    'Output title-only chapters by setting chapter summaries to null.',
  ].join(' ')
}

function transcriptDurationSeconds(segments: TranscriptSegment[]): number {
  if (segments.length === 0) {
    return 0
  }

  const first = segments[0]
  const last = segments[segments.length - 1]
  return Math.max(0, last.endSeconds - first.startSeconds)
}

function targetChapterCount(durationSeconds: number): number {
  if (durationSeconds <= 0) {
    return 1
  }

  return Math.max(1, Math.round(durationSeconds / 135))
}

function normalizeAudioSource(audio: AudioTranscriptSource): Exclude<AudioTranscriptSource, string> {
  if (Array.isArray(audio)) {
    return audio.length > 0 ? audio : []
  }

  return [{ path: audio, startSeconds: 0, index: 0 }]
}

function toFiniteSeconds(seconds: number): number {
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0
}

async function transcriptionCacheKey(audioPath: string, model: string): Promise<string> {
  return buildCacheKey(['transcription-v1', model, await hashFile(audioPath)])
}

function insightsFromParsed(parsed: z.infer<typeof InsightsSchema>, features: FeatureSet): InsightResult {
  const includeChapterSummaries = process.env.CHAPTER_SUMMARIES_ENABLED === '1'

  return {
    ...(features.summary && parsed.summary ? { summary: enforceSummaryLimit(parsed.summary) } : {}),
    ...(features.chapters
      ? {
          chapters: normalizeEditorialChapters(
            parsed.chapters.map((chapter) => ({
              startSeconds: chapter.start_seconds,
              title: chapter.title,
              summary: chapter.summary,
            })),
            { includeSummaries: includeChapterSummaries },
          ),
        }
      : {}),
  }
}

function getTranscriptionConcurrency(): number {
  const configured = Number(process.env.TRANSCRIPTION_CONCURRENCY)

  if (!Number.isFinite(configured) || configured <= 0) {
    return 2
  }

  return Math.min(Math.max(Math.floor(configured), 1), 4)
}

function getOpenAITimeout(name: string, fallback: number): number {
  const configured = Number(process.env[name])

  if (!Number.isFinite(configured) || configured <= 0) {
    return fallback
  }

  return Math.floor(configured)
}

function toCitation(citation: z.infer<typeof AnswerSchema>['citations'][number]): Citation {
  return {
    timestamp: citation.timestamp || formatTimestamp(citation.start_seconds),
    startSeconds: citation.start_seconds,
    endSeconds: citation.end_seconds,
    text: citation.text.trim(),
  }
}

function toChunkCitation(chunk: TranscriptChunk): Citation {
  return {
    timestamp: chunk.timestamp,
    startSeconds: chunk.startSeconds,
    endSeconds: chunk.endSeconds,
    text: chunk.text,
  }
}
