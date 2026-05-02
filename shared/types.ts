export type FeatureSet = {
  summary: boolean
  chapters: boolean
  qa: boolean
}

export type DependencyStatus = {
  name: 'yt-dlp' | 'ffmpeg' | 'openai'
  ok: boolean
  detail: string
}

export type VideoMetadata = {
  id: string
  title: string
  channel?: string
  durationSeconds?: number
  thumbnailUrl?: string
  webpageUrl: string
}

export type TranscriptSegment = {
  id: string
  startSeconds: number
  endSeconds: number
  timestamp: string
  text: string
  speaker?: string
}

export type Chapter = {
  timestamp: string
  title: string
  summary?: string
}

export type Citation = {
  timestamp: string
  startSeconds: number
  endSeconds: number
  text: string
}

export type AnalyzeRequest = {
  url: string
  features?: Partial<FeatureSet>
}

export type AnalyzeResponse = {
  sessionId: string
  video: VideoMetadata
  transcript: {
    text: string
    segments: TranscriptSegment[]
  }
  summary?: string
  chapters?: Chapter[]
  qaReady: boolean
}

export type AnalysisRecord = AnalyzeResponse & {
  createdAt: string
  updatedAt: string
  features: FeatureSet
}

export type AnalysisListItem = {
  sessionId: string
  video: VideoMetadata
  createdAt: string
  updatedAt: string
  summaryPreview?: string
  chapterCount: number
  transcriptSegmentCount: number
  qaReady: boolean
}

export type ExportFormat = 'markdown' | 'text'

export type ExportPreset = 'summary' | 'full-transcript'

export type ExportResponse = {
  filename: string
  mimeType: string
  content: string
}

export type AskRequest = {
  sessionId: string
  question: string
}

export type AskResponse = {
  reasoning: string
  answer: string
  citations: Citation[]
}

export type ApiErrorBody = {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type AnalyzeStage = 'queued' | 'validating' | 'metadata' | 'audio' | 'transcribing' | 'embedding' | 'insights'

export type AnalyzeJobStartResponse = {
  jobId: string
}

export type AnalyzeJobStatusResponse = {
  jobId: string
  status: 'queued' | 'running' | 'ready' | 'error' | 'cancelled'
  stage: AnalyzeStage
  label: string
  detail?: string
  activeStep: number
  totalSteps: number
  startedAt: string
  updatedAt: string
  result?: AnalyzeResponse
  error?: ApiErrorBody['error']
}

export type HealthResponse = {
  ok: boolean
  dependencies: DependencyStatus[]
  defaults: {
    transcriptionModel: string
    textModel: string
    embeddingModel: string
  }
}
