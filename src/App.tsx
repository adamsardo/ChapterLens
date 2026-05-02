import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  Clock3,
  FileText,
  HelpCircle,
  Loader2,
  MessageSquareText,
  Play,
  Search,
  Sparkles,
} from 'lucide-react'
import type { AnalyzeJobStatusResponse, AnalyzeResponse, AnalyzeStage, AskResponse, FeatureSet, HealthResponse } from '../shared/types'
import { ApiClientError, askVideoQuestion, getAnalyzeJob, getHealth, startAnalyzeJob } from './lib/api'
import './App.css'

type AnalyzeStatus = 'idle' | 'loading' | 'ready' | 'error'

type QaTurn = {
  id: string
  question: string
  response?: AskResponse
  error?: string
}

const defaultFeatures: FeatureSet = {
  summary: true,
  chapters: true,
  qa: true,
}

const progressSteps: Array<{ stage: AnalyzeStage; label: string }> = [
  { stage: 'validating', label: 'Validate' },
  { stage: 'metadata', label: 'Metadata' },
  { stage: 'audio', label: 'Audio' },
  { stage: 'transcribing', label: 'Transcribe' },
  { stage: 'embedding', label: 'Index' },
  { stage: 'insights', label: 'Analyze' },
]

function App() {
  const [url, setUrl] = useState('')
  const [features, setFeatures] = useState<FeatureSet>(defaultFeatures)
  const [status, setStatus] = useState<AnalyzeStatus>('idle')
  const [analysisProgress, setAnalysisProgress] = useState<AnalyzeJobStatusResponse | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [question, setQuestion] = useState('')
  const [qaTurns, setQaTurns] = useState<QaTurn[]>([])
  const [qaLoading, setQaLoading] = useState(false)

  const selectedFeatureCount = Object.values(features).filter(Boolean).length
  const canAnalyze = url.trim().length > 0 && selectedFeatureCount > 0 && status !== 'loading'

  const wordCount = useMemo(() => {
    return analysis?.summary?.trim().split(/\s+/).filter(Boolean).length ?? 0
  }, [analysis?.summary])

  useEffect(() => {
    void getHealth()
      .then(setHealth)
      .catch(() => {
        setHealth(null)
      })
  }, [])

  useEffect(() => {
    if (status !== 'loading') {
      setElapsedSeconds(0)
      return
    }

    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)

    return () => window.clearInterval(timer)
  }, [status])

  async function handleAnalyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setStatus('loading')
    setError(null)
    setAnalysis(null)
    setAnalysisProgress(null)
    setQaTurns([])

    try {
      const { jobId } = await startAnalyzeJob({
        url,
        features,
      })

      for (;;) {
        const job = await getAnalyzeJob(jobId)
        setAnalysisProgress(job)

        if (job.status === 'ready') {
          if (!job.result) {
            throw new ApiClientError(
              'INCOMPLETE_JOB',
              'Analysis finished but no result was returned.',
              { jobId },
            )
          }
          setAnalysis(job.result)
          setStatus('ready')
          return
        }

        if (job.status === 'error') {
          if (job.error) {
            throw new ApiClientError(job.error.code, job.error.message, job.error.details)
          }
          throw new ApiClientError('ANALYSIS_FAILED', 'Analysis failed without an error payload.')
        }

        await sleep(1200)
      }
    } catch (caught) {
      setStatus('error')
      setError(toDisplayError(caught))
    }
  }

  async function handleAsk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmedQuestion = question.trim()
    if (!analysis?.sessionId || !trimmedQuestion) {
      return
    }

    const turnId = crypto.randomUUID()
    setQuestion('')
    setQaLoading(true)
    setQaTurns((turns) => [...turns, { id: turnId, question: trimmedQuestion }])

    try {
      const response = await askVideoQuestion({
        sessionId: analysis.sessionId,
        question: trimmedQuestion,
      })
      setQaTurns((turns) => turns.map((turn) => (turn.id === turnId ? { ...turn, response } : turn)))
    } catch (caught) {
      setQaTurns((turns) =>
        turns.map((turn) => (turn.id === turnId ? { ...turn, error: toDisplayError(caught) } : turn)),
      )
    } finally {
      setQaLoading(false)
    }
  }

  function toggleFeature(feature: keyof FeatureSet) {
    setFeatures((current) => ({
      ...current,
      [feature]: !current[feature],
    }))
  }

  return (
    <main className="app-shell">
      <section className="command-surface" aria-labelledby="app-title">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <Play size={16} fill="currentColor" />
            </span>
            <div>
              <h1 id="app-title">ChapterLens</h1>
              <p>Video answers from the actual transcript.</p>
            </div>
          </div>
          <HealthBadge health={health} />
        </header>

        <form className="url-form" onSubmit={handleAnalyze}>
          <label className="url-input-wrap">
            <Search size={20} aria-hidden="true" />
            <span className="sr-only">YouTube video URL</span>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="Paste a YouTube URL"
              autoComplete="url"
            />
          </label>
          <button className="primary-button" type="submit" disabled={!canAnalyze}>
            {status === 'loading' ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
            Analyze
          </button>
        </form>

        <div className="feature-row" aria-label="Outputs to generate">
          <FeatureToggle
            active={features.summary}
            icon={<FileText size={16} />}
            label="Summary"
            onClick={() => toggleFeature('summary')}
          />
          <FeatureToggle
            active={features.chapters}
            icon={<BookOpen size={16} />}
            label="Chapters"
            onClick={() => toggleFeature('chapters')}
          />
          <FeatureToggle
            active={features.qa}
            icon={<MessageSquareText size={16} />}
            label="Q&A"
            onClick={() => toggleFeature('qa')}
          />
        </div>

        {status === 'loading' && <ProgressStrip progress={analysisProgress} elapsedSeconds={elapsedSeconds} />}
        {error && <ErrorNotice message={error} />}
        {health && !health.ok && <SetupNotice health={health} />}
      </section>

      <section className="workspace" aria-live="polite">
        <div className="insights-column">
          {analysis ? (
            <>
              <VideoHeader analysis={analysis} />
              {analysis.summary && (
                <section className="panel">
                  <PanelTitle icon={<FileText size={18} />} title="Summary" meta={`${wordCount} words`} />
                  <p className="summary-text">{analysis.summary}</p>
                </section>
              )}
              {analysis.chapters && analysis.chapters.length > 0 && (
                <section className="panel">
                  <PanelTitle icon={<BookOpen size={18} />} title="Chapters" meta={`${analysis.chapters.length} sections`} />
                  <ol className="chapter-list">
                    {analysis.chapters.map((chapter) => (
                      <li key={`${chapter.timestamp}-${chapter.title}`}>
                        <time>{chapter.timestamp}</time>
                        <div>
                          <h3>{chapter.title}</h3>
                          {chapter.summary && <p>{chapter.summary}</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </>
          ) : (
            <EmptyState />
          )}
        </div>

        <aside className="qa-column" aria-label="Video Q&A">
          <div className="qa-header">
            <PanelTitle icon={<HelpCircle size={18} />} title="Q&A" meta={analysis?.qaReady ? 'Ready' : 'Waiting'} />
          </div>

          <div className="qa-thread">
            {qaTurns.length === 0 ? (
              <div className="qa-empty">
                <MessageSquareText size={26} aria-hidden="true" />
                <p>Ask about claims, definitions, examples, or moments in the video.</p>
              </div>
            ) : (
              qaTurns.map((turn) => <QaTurnView key={turn.id} turn={turn} />)
            )}
          </div>

          <form className="qa-form" onSubmit={handleAsk}>
            <label>
              <span className="sr-only">Ask a question about the video</span>
              <input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder={analysis?.qaReady ? 'Ask a precise question' : 'Analyze with Q&A enabled'}
                disabled={!analysis?.qaReady || qaLoading}
              />
            </label>
            <button type="submit" disabled={!analysis?.qaReady || !question.trim() || qaLoading}>
              {qaLoading ? <Loader2 className="spin" size={17} /> : <ArrowRight size={17} />}
            </button>
          </form>
        </aside>
      </section>
    </main>
  )
}

function FeatureToggle({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button className={`feature-toggle ${active ? 'is-active' : ''}`} type="button" aria-pressed={active} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {active && <Check size={14} aria-hidden="true" />}
    </button>
  )
}

function HealthBadge({ health }: { health: HealthResponse | null }) {
  if (!health) {
    return <span className="health-badge is-muted">Checking API</span>
  }

  return (
    <span className={`health-badge ${health.ok ? 'is-ok' : 'is-warn'}`}>
      {health.ok ? <Check size={14} /> : <AlertTriangle size={14} />}
      {health.ok ? 'API ready' : 'Setup needed'}
    </span>
  )
}

function ProgressStrip({
  progress,
  elapsedSeconds,
}: {
  progress: AnalyzeJobStatusResponse | null
  elapsedSeconds: number
}) {
  const activeIndex = progress?.activeStep ?? 0

  return (
    <div className="progress-wrap" role="status" aria-label="Analysis progress">
      <div className="progress-strip">
        {progressSteps.map((step, index) => {
          const stepNumber = index + 1
          const isActive = stepNumber <= activeIndex
          const isCurrent = stepNumber === activeIndex && progress?.status !== 'ready'

          return (
            <div className={isActive ? 'is-active' : ''} key={step.stage}>
              <span>{stepNumber < activeIndex ? <Check size={13} /> : isCurrent ? <Loader2 className="spin" size={13} /> : stepNumber}</span>
              {step.label}
            </div>
          )
        })}
      </div>
      <div className="progress-detail">
        <div>
          <strong>{progress?.label ?? 'Starting analysis'}</strong>
          {progress?.detail && <p>{progress.detail}</p>}
        </div>
        <time>{formatElapsed(elapsedSeconds)}</time>
      </div>
    </div>
  )
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="notice is-error" role="alert">
      <AlertTriangle size={18} />
      <p>{message}</p>
    </div>
  )
}

function SetupNotice({ health }: { health: HealthResponse }) {
  const missing = health.dependencies.filter((dependency) => !dependency.ok)

  return (
    <div className="notice is-setup">
      <AlertTriangle size={18} />
      <div>
        <p>Missing setup: {missing.map((dependency) => dependency.name).join(', ')}</p>
        <span>Install local video tools and set OPENAI_API_KEY to run real analysis.</span>
      </div>
    </div>
  )
}

function VideoHeader({ analysis }: { analysis: AnalyzeResponse }) {
  return (
    <section className="video-header">
      {analysis.video.thumbnailUrl ? <img src={analysis.video.thumbnailUrl} alt="" /> : <div className="thumbnail-fallback" />}
      <div>
        <p className="video-channel">{analysis.video.channel ?? 'YouTube video'}</p>
        <h2>{analysis.video.title}</h2>
        <div className="video-meta">
          <span>
            <Clock3 size={14} />
            {formatDuration(analysis.video.durationSeconds)}
          </span>
          <span>{analysis.transcript.segments.length} transcript segments</span>
        </div>
      </div>
    </section>
  )
}

function PanelTitle({ icon, title, meta }: { icon: ReactNode; title: string; meta?: string }) {
  return (
    <div className="panel-title">
      <div>
        {icon}
        <h2>{title}</h2>
      </div>
      {meta && <span>{meta}</span>}
    </div>
  )
}

function EmptyState() {
  return (
    <section className="empty-panel">
      <div className="empty-orbit">
        <Play size={22} fill="currentColor" />
      </div>
      <h2>Paste a video to begin.</h2>
      <p>
        ChapterLens will transcribe the audio, identify sections, summarize the content, and keep Q&A grounded in
        timestamped transcript evidence.
      </p>
    </section>
  )
}

function QaTurnView({ turn }: { turn: QaTurn }) {
  return (
    <article className="qa-turn">
      <p className="question">{turn.question}</p>
      {turn.error && (
        <div className="qa-error">
          <AlertTriangle size={16} />
          {turn.error}
        </div>
      )}
      {!turn.response && !turn.error && (
        <div className="qa-pending">
          <Loader2 className="spin" size={16} />
          Searching transcript context
        </div>
      )}
      {turn.response && (
        <div className="answer-stack">
          <section>
            <h3>Reasoning</h3>
            <p>{turn.response.reasoning}</p>
            <div className="citation-row">
              {turn.response.citations.map((citation) => (
                <span key={`${citation.timestamp}-${citation.text.slice(0, 20)}`}>{citation.timestamp}</span>
              ))}
            </div>
          </section>
          <section>
            <h3>Answer</h3>
            <p>{turn.response.answer}</p>
          </section>
        </div>
      )}
    </article>
  )
}

function formatDuration(seconds?: number): string {
  if (!seconds) {
    return 'Duration unknown'
  }

  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function toDisplayError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.message
  }

  if (error instanceof Error) {
    return error.message
  }

  return 'Something went wrong.'
}

export default App