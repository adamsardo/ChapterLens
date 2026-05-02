import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AnalysisListItem,
  AnalysisRecord,
  AnalyzeJobStatusResponse,
  AnalyzeRequest,
  AnalyzeResponse,
  AnalyzeStage,
  AskResponse,
  Citation,
  ExportFormat,
  ExportPreset,
  FeatureSet,
  HealthResponse,
  TranscriptSegment,
} from '../shared/types'
import { parseTimestamp } from '../shared/time'
import {
  ApiClientError,
  askVideoQuestion,
  cancelAnalyzeJob,
  exportAnalysis,
  getAnalysisRecord,
  getHealth,
  listAnalyses,
  startAnalyzeJob,
  subscribeAnalyzeJob,
} from './lib/api'
import './App.css'

type AnalyzeStatus = 'idle' | 'loading' | 'ready' | 'error' | 'cancelled'

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

type IconName =
  | 'alert'
  | 'arrow-right'
  | 'book'
  | 'check'
  | 'clock'
  | 'download'
  | 'file'
  | 'help'
  | 'library'
  | 'loader'
  | 'message'
  | 'play'
  | 'reset'
  | 'search'
  | 'spark'
  | 'stop'

function Icon({ name, size = 16, className = '', filled = false }: { name: IconName; size?: number; className?: string; filled?: boolean }) {
  const paths: Record<IconName, ReactNode> = {
    alert: (
      <>
        <path d="M12 4.2 3.5 19h17L12 4.2Z" />
        <path d="M12 9v4.5" />
        <path d="M12 16.8h.01" />
      </>
    ),
    'arrow-right': (
      <>
        <path d="M5 12h14" />
        <path d="m13 6 6 6-6 6" />
      </>
    ),
    book: (
      <>
        <path d="M5.5 5.5h7A3.5 3.5 0 0 1 16 9v10.5h-7A3.5 3.5 0 0 0 5.5 23V5.5Z" />
        <path d="M16 9a3.5 3.5 0 0 1 3.5-3.5h-1A3.5 3.5 0 0 0 15 9v10.5" />
      </>
    ),
    check: <path d="m5 12.5 4 4L19.5 6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 7.5v5l3.5 2" />
      </>
    ),
    download: (
      <>
        <path d="M12 4v10" />
        <path d="m7.5 10 4.5 4.5L16.5 10" />
        <path d="M5 19.5h14" />
      </>
    ),
    file: (
      <>
        <path d="M7 4.5h7l3.5 3.5v11.5H7V4.5Z" />
        <path d="M14 4.5V8h3.5" />
        <path d="M9.5 12h5" />
        <path d="M9.5 15.5h4" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M9.6 9.4A2.6 2.6 0 1 1 12 13v1" />
        <path d="M12 17.4h.01" />
      </>
    ),
    library: (
      <>
        <path d="M5 6h3v13H5V6Z" />
        <path d="M10.5 5h3v14h-3V5Z" />
        <path d="m16 6 3 1v12l-3-1V6Z" />
      </>
    ),
    loader: (
      <>
        <path d="M12 4v3" />
        <path d="M12 17v3" />
        <path d="M4 12h3" />
        <path d="M17 12h3" />
        <path d="m6.3 6.3 2.1 2.1" />
        <path d="m15.6 15.6 2.1 2.1" />
      </>
    ),
    message: (
      <>
        <path d="M5 6.5h14v10H9l-4 3v-13Z" />
        <path d="M8.5 10h7" />
        <path d="M8.5 13h4.5" />
      </>
    ),
    play: filled ? <path d="M8 5.5v13l11-6.5L8 5.5Z" /> : <path d="M8 5.5v13l11-6.5L8 5.5Z" />,
    reset: (
      <>
        <path d="M6.2 9A6.5 6.5 0 1 1 5.8 15" />
        <path d="M6 5.5V9h3.5" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="5.5" />
        <path d="m15 15 4 4" />
      </>
    ),
    spark: (
      <>
        <path d="M12 4.5 13.7 10l5.3 2-5.3 2L12 19.5 10.3 14 5 12l5.3-2L12 4.5Z" />
        <path d="M18.5 4.5v3" />
        <path d="M17 6h3" />
      </>
    ),
    stop: <path d="M7 7h10v10H7V7Z" />,
  }

  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.2"
    >
      {paths[name]}
    </svg>
  )
}

function App() {
  const [url, setUrl] = useState('')
  const [features, setFeatures] = useState<FeatureSet>(defaultFeatures)
  const [status, setStatus] = useState<AnalyzeStatus>('idle')
  const [analysisProgress, setAnalysisProgress] = useState<AnalyzeJobStatusResponse | null>(null)
  const [currentJobId, setCurrentJobId] = useState<string | null>(null)
  const [lastAnalyzeRequest, setLastAnalyzeRequest] = useState<AnalyzeRequest | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [recentAnalyses, setRecentAnalyses] = useState<AnalysisListItem[]>([])
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [transcriptQuery, setTranscriptQuery] = useState('')
  const [activeTranscriptId, setActiveTranscriptId] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [qaTurns, setQaTurns] = useState<QaTurn[]>([])
  const [qaLoading, setQaLoading] = useState(false)
  const [exportPreset, setExportPreset] = useState<ExportPreset>('summary')
  const [exportFormat, setExportFormat] = useState<ExportFormat>('markdown')
  const [exportLoading, setExportLoading] = useState(false)
  const [cancelLoading, setCancelLoading] = useState(false)
  const unsubscribeJobRef = useRef<(() => void) | null>(null)

  const selectedFeatureCount = Object.values(features).filter(Boolean).length
  const canAnalyze = url.trim().length > 0 && selectedFeatureCount > 0 && status !== 'loading'

  const wordCount = useMemo(() => {
    return analysis?.summary?.trim().split(/\s+/).filter(Boolean).length ?? 0
  }, [analysis?.summary])

  const filteredTranscriptSegments = useMemo(() => {
    const segments = analysis?.transcript.segments ?? []
    const query = transcriptQuery.trim().toLowerCase()

    if (!query) {
      return segments
    }

    return segments.filter((segment) => {
      return (
        segment.text.toLowerCase().includes(query) ||
        segment.timestamp.includes(query) ||
        segment.speaker?.toLowerCase().includes(query)
      )
    })
  }, [analysis?.transcript.segments, transcriptQuery])

  useEffect(() => {
    const revealItems = Array.from(document.querySelectorAll<HTMLElement>('.reveal'))

    if (!('IntersectionObserver' in window)) {
      revealItems.forEach((item) => item.classList.add('is-visible'))
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible')
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.12 },
    )

    revealItems.forEach((item) => observer.observe(item))

    return () => observer.disconnect()
  }, [analysis?.sessionId, qaTurns.length, status])

  useEffect(() => {
    void getHealth()
      .then(setHealth)
      .catch(() => {
        setHealth(null)
      })
    setLibraryLoading(true)
    void listAnalyses()
      .then(setRecentAnalyses)
      .catch(() => {
        setRecentAnalyses([])
      })
      .finally(() => {
        setLibraryLoading(false)
      })
  }, [])

  useEffect(() => {
    return () => {
      unsubscribeJobRef.current?.()
    }
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
    await beginAnalysis({ url, features })
  }

  async function beginAnalysis(request: AnalyzeRequest) {
    setStatus('loading')
    setError(null)
    setAnalysis(null)
    setAnalysisProgress(null)
    setCurrentJobId(null)
    setCancelLoading(false)
    setTranscriptQuery('')
    setActiveTranscriptId(null)
    setQaTurns([])
    setLastAnalyzeRequest(request)
    unsubscribeJobRef.current?.()

    try {
      const { jobId } = await startAnalyzeJob(request)
      setCurrentJobId(jobId)
      unsubscribeJobRef.current = subscribeAnalyzeJob(
        jobId,
        (job) => {
          setAnalysisProgress(job)

          if (job.status === 'ready') {
            if (!job.result) {
              setStatus('error')
              setError('Analysis finished but no result was returned.')
              return
            }

            setAnalysis(job.result)
            setStatus('ready')
            setCurrentJobId(null)
            setCancelLoading(false)
            unsubscribeJobRef.current?.()
            unsubscribeJobRef.current = null
            void refreshLibrary()
            return
          }

          if (job.status === 'error') {
            setStatus('error')
            setError(job.error?.message ?? 'Analysis failed without an error payload.')
            setCurrentJobId(null)
            setCancelLoading(false)
            unsubscribeJobRef.current?.()
            unsubscribeJobRef.current = null
            return
          }

          if (job.status === 'cancelled') {
            setStatus('cancelled')
            setCurrentJobId(null)
            setCancelLoading(false)
            unsubscribeJobRef.current?.()
            unsubscribeJobRef.current = null
          }
        },
        () => {
          setStatus('error')
          setError('Lost the live progress connection. Retry the analysis to continue.')
          setCurrentJobId(null)
          setCancelLoading(false)
        },
      )
    } catch (caught) {
      setStatus('error')
      setError(toDisplayError(caught))
      setCurrentJobId(null)
      setCancelLoading(false)
    }
  }

  async function handleCancelAnalysis() {
    if (!currentJobId) {
      return
    }

    setCancelLoading(true)
    try {
      const job = await cancelAnalyzeJob(currentJobId)
      setAnalysisProgress(job)
      if (job.status === 'cancelled') {
        setStatus('cancelled')
        setCurrentJobId(null)
      }
    } catch (caught) {
      setError(toDisplayError(caught))
    } finally {
      setCancelLoading(false)
    }
  }

  async function handleRetryAnalysis() {
    await beginAnalysis(lastAnalyzeRequest ?? { url, features })
  }

  async function refreshLibrary() {
    setLibraryLoading(true)
    try {
      setRecentAnalyses(await listAnalyses())
    } catch {
      setRecentAnalyses([])
    } finally {
      setLibraryLoading(false)
    }
  }

  async function handleLoadAnalysis(sessionId: string) {
    setError(null)
    setQaTurns([])
    setTranscriptQuery('')
    setActiveTranscriptId(null)
    unsubscribeJobRef.current?.()

    try {
      const record: AnalysisRecord = await getAnalysisRecord(sessionId)
      setAnalysis(record)
      setUrl(record.video.webpageUrl)
      setFeatures(record.features)
      setStatus('ready')
    } catch (caught) {
      setStatus('error')
      setError(toDisplayError(caught))
    }
  }

  async function handleExport() {
    if (!analysis?.sessionId) {
      return
    }

    setExportLoading(true)
    try {
      const exported = await exportAnalysis(analysis.sessionId, {
        preset: exportPreset,
        format: exportFormat,
      })
      downloadText(exported.filename, exported.mimeType, exported.content)
    } catch (caught) {
      setError(toDisplayError(caught))
    } finally {
      setExportLoading(false)
    }
  }

  function jumpToTranscript(startSeconds: number) {
    const segments = analysis?.transcript.segments ?? []
    const target =
      segments.find((segment) => startSeconds >= segment.startSeconds && startSeconds <= segment.endSeconds) ??
      segments.find((segment) => segment.startSeconds >= startSeconds) ??
      segments[0]

    if (!target) {
      return
    }

    setActiveTranscriptId(target.id)
    window.requestAnimationFrame(() => {
      document.getElementById(transcriptDomId(target.id))?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    })
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
      <section className="command-surface reveal" aria-labelledby="app-title">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <Icon name="play" size={16} filled />
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
            <Icon name="search" size={20} />
            <span className="sr-only">YouTube video URL</span>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="Paste a YouTube URL"
              autoComplete="url"
              inputMode="url"
              spellCheck={false}
            />
          </label>
          <button className="primary-button" type="submit" disabled={!canAnalyze}>
            {status === 'loading' ? <Icon name="loader" className="spin" size={18} /> : <Icon name="spark" size={18} />}
            Analyze
          </button>
        </form>

        <div className="feature-row" aria-label="Outputs to generate">
          <FeatureToggle
            active={features.summary}
            icon={<Icon name="file" size={16} />}
            label="Summary"
            onClick={() => toggleFeature('summary')}
          />
          <FeatureToggle
            active={features.chapters}
            icon={<Icon name="book" size={16} />}
            label="Chapters"
            onClick={() => toggleFeature('chapters')}
          />
          <FeatureToggle
            active={features.qa}
            icon={<Icon name="message" size={16} />}
            label="Q&A"
            onClick={() => toggleFeature('qa')}
          />
        </div>

        <RecentAnalyses
          activeSessionId={analysis?.sessionId}
          analyses={recentAnalyses}
          loading={libraryLoading}
          onLoad={handleLoadAnalysis}
        />

        {status === 'loading' && (
          <ProgressStrip
            progress={analysisProgress}
            elapsedSeconds={elapsedSeconds}
            cancelLoading={cancelLoading}
            onCancel={handleCancelAnalysis}
          />
        )}
        {status === 'cancelled' && <CancelledNotice onRetry={handleRetryAnalysis} />}
        {error && <ErrorNotice message={error} onRetry={handleRetryAnalysis} />}
        {health && !health.ok && <SetupNotice health={health} />}
      </section>

      <section className="workspace reveal" aria-live="polite">
        <div className="insights-column">
          {analysis ? (
            <>
              <VideoHeader
                analysis={analysis}
                exportPreset={exportPreset}
                exportFormat={exportFormat}
                exportLoading={exportLoading}
                onExport={handleExport}
                onExportPresetChange={setExportPreset}
                onExportFormatChange={setExportFormat}
              />
              {analysis.summary && (
                <section className="panel reveal">
                  <PanelTitle icon={<Icon name="file" size={18} />} title="Summary" meta={`${wordCount} words`} />
                  <p className="summary-text">{analysis.summary}</p>
                </section>
              )}
              {analysis.chapters && analysis.chapters.length > 0 && (
                <section className="panel reveal">
                  <PanelTitle icon={<Icon name="book" size={18} />} title="Chapters" meta={`${analysis.chapters.length} sections`} />
                  <ol className="chapter-list">
                    {analysis.chapters.map((chapter) => (
                      <li key={`${chapter.timestamp}-${chapter.title}`}>
                        <button
                          type="button"
                          aria-label={`Jump to transcript at ${chapter.timestamp}`}
                          onClick={() => jumpToTranscript(parseTimestamp(chapter.timestamp))}
                        >
                          <time>{chapter.timestamp}</time>
                        </button>
                        <div>
                          <h3>{chapter.title}</h3>
                          {chapter.summary && <p>{chapter.summary}</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              <TranscriptPanel
                activeTranscriptId={activeTranscriptId}
                query={transcriptQuery}
                segments={filteredTranscriptSegments}
                totalSegments={analysis.transcript.segments.length}
                onQueryChange={setTranscriptQuery}
                onSelectSegment={(segment) => jumpToTranscript(segment.startSeconds)}
              />
            </>
          ) : (
            <EmptyState />
          )}
        </div>

        <aside className="qa-column reveal" aria-label="Video Q&A">
          <div className="qa-header">
            <PanelTitle icon={<Icon name="help" size={18} />} title="Q&A" meta={analysis?.qaReady ? 'Ready' : 'Waiting'} />
          </div>

          <div className="qa-thread">
            {qaTurns.length === 0 ? (
              <div className="qa-empty">
                <Icon name="message" size={26} />
                <p>Ask about claims, definitions, examples, or moments in the video.</p>
              </div>
            ) : (
              qaTurns.map((turn) => <QaTurnView key={turn.id} turn={turn} onSelectCitation={jumpToTranscript} />)
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
                enterKeyHint="send"
              />
            </label>
            <button
              type="submit"
              aria-label="Ask question"
              disabled={!analysis?.qaReady || !question.trim() || qaLoading}
            >
              {qaLoading ? <Icon name="loader" className="spin" size={17} /> : <Icon name="arrow-right" size={17} />}
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
      {active && <Icon name="check" size={14} />}
    </button>
  )
}

function RecentAnalyses({
  activeSessionId,
  analyses,
  loading,
  onLoad,
}: {
  activeSessionId?: string
  analyses: AnalysisListItem[]
  loading: boolean
  onLoad: (sessionId: string) => void
}) {
  if (loading && analyses.length === 0) {
    return (
      <div className="recent-analyses is-loading">
        <Icon name="library" size={15} />
        Loading local library
      </div>
    )
  }

  if (analyses.length === 0) {
    return null
  }

  return (
    <section className="recent-analyses" aria-label="Recent analyses">
      <div className="recent-title">
        <Icon name="library" size={15} />
        <span>Recent</span>
      </div>
      <div className="recent-list">
        {analyses.slice(0, 4).map((item) => (
          <button
            className={item.sessionId === activeSessionId ? 'is-active' : ''}
            key={item.sessionId}
            type="button"
            aria-current={item.sessionId === activeSessionId ? 'true' : undefined}
            onClick={() => onLoad(item.sessionId)}
          >
            <strong>{item.video.title}</strong>
            <span>
              {item.chapterCount} chapters - {item.transcriptSegmentCount} segments
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

function HealthBadge({ health }: { health: HealthResponse | null }) {
  if (!health) {
    return <span className="health-badge is-muted">Checking API</span>
  }

  return (
    <span className={`health-badge ${health.ok ? 'is-ok' : 'is-warn'}`}>
      {health.ok ? <Icon name="check" size={14} /> : <Icon name="alert" size={14} />}
      {health.ok ? 'API ready' : 'Setup needed'}
    </span>
  )
}

function ProgressStrip({
  progress,
  elapsedSeconds,
  cancelLoading,
  onCancel,
}: {
  progress: AnalyzeJobStatusResponse | null
  elapsedSeconds: number
  cancelLoading: boolean
  onCancel: () => void
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
              <span>{stepNumber < activeIndex ? <Icon name="check" size={13} /> : isCurrent ? <Icon name="loader" className="spin" size={13} /> : stepNumber}</span>
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
        <div className="progress-actions">
          <time>{formatElapsed(elapsedSeconds)}</time>
          <button type="button" onClick={onCancel} disabled={cancelLoading}>
            {cancelLoading ? <Icon name="loader" className="spin" size={14} /> : <Icon name="stop" size={14} />}
            Stop
          </button>
        </div>
      </div>
    </div>
  )
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="notice is-error" role="alert">
      <Icon name="alert" size={18} />
      <div>
        <p>{message}</p>
        <button type="button" onClick={onRetry}>
          <Icon name="reset" size={14} />
          Retry analysis
        </button>
      </div>
    </div>
  )
}

function CancelledNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="notice is-cancelled" role="status">
      <Icon name="stop" size={18} />
      <div>
        <p>Analysis cancelled.</p>
        <button type="button" onClick={onRetry}>
          <Icon name="reset" size={14} />
          Retry analysis
        </button>
      </div>
    </div>
  )
}

function SetupNotice({ health }: { health: HealthResponse }) {
  const missing = health.dependencies.filter((dependency) => !dependency.ok)

  return (
    <div className="notice is-setup">
      <Icon name="alert" size={18} />
      <div>
        <p>Missing setup: {missing.map((dependency) => dependency.name).join(', ')}</p>
        <span>Install local video tools and set OPENAI_API_KEY to run real analysis.</span>
      </div>
    </div>
  )
}

function VideoHeader({
  analysis,
  exportPreset,
  exportFormat,
  exportLoading,
  onExport,
  onExportPresetChange,
  onExportFormatChange,
}: {
  analysis: AnalyzeResponse
  exportPreset: ExportPreset
  exportFormat: ExportFormat
  exportLoading: boolean
  onExport: () => void
  onExportPresetChange: (preset: ExportPreset) => void
  onExportFormatChange: (format: ExportFormat) => void
}) {
  return (
    <section className="video-header reveal">
      {analysis.video.thumbnailUrl ? <img src={analysis.video.thumbnailUrl} alt="" /> : <div className="thumbnail-fallback" />}
      <div>
        <p className="video-channel">{analysis.video.channel ?? 'YouTube video'}</p>
        <h2>{analysis.video.title}</h2>
        <div className="video-meta">
          <span>
            <Icon name="clock" size={14} />
            {formatDuration(analysis.video.durationSeconds)}
          </span>
          <span>{analysis.transcript.segments.length} transcript segments</span>
        </div>
        <div className="export-row" aria-label="Export analysis">
          <label>
            <span className="sr-only">Export preset</span>
            <select value={exportPreset} onChange={(event) => onExportPresetChange(event.target.value as ExportPreset)}>
              <option value="summary">Summary</option>
              <option value="full-transcript">Full transcript</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Export format</span>
            <select value={exportFormat} onChange={(event) => onExportFormatChange(event.target.value as ExportFormat)}>
              <option value="markdown">Markdown</option>
              <option value="text">Text</option>
            </select>
          </label>
          <button type="button" onClick={onExport} disabled={exportLoading}>
            {exportLoading ? <Icon name="loader" className="spin" size={15} /> : <Icon name="download" size={15} />}
            Export
          </button>
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

function TranscriptPanel({
  activeTranscriptId,
  query,
  segments,
  totalSegments,
  onQueryChange,
  onSelectSegment,
}: {
  activeTranscriptId: string | null
  query: string
  segments: TranscriptSegment[]
  totalSegments: number
  onQueryChange: (query: string) => void
  onSelectSegment: (segment: TranscriptSegment) => void
}) {
  const resultMeta = query.trim() ? `${segments.length} of ${totalSegments} matches` : `${totalSegments} segments`

  return (
    <section className="panel transcript-panel reveal">
      <PanelTitle icon={<Icon name="file" size={18} />} title="Transcript" meta={resultMeta} />
      <label className="transcript-search">
        <Icon name="search" size={17} />
        <span className="sr-only">Search transcript</span>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search transcript, timestamp, or speaker"
          type="search"
          enterKeyHint="search"
        />
      </label>
      <ol className="transcript-list">
        {segments.length === 0 ? (
          <li className="transcript-empty">No transcript segments match this search.</li>
        ) : (
          segments.map((segment) => (
            <li className={segment.id === activeTranscriptId ? 'is-active' : ''} id={transcriptDomId(segment.id)} key={segment.id}>
              <button
                type="button"
                aria-label={`Jump to transcript at ${segment.timestamp}`}
                onClick={() => onSelectSegment(segment)}
              >
                <time>{segment.timestamp}</time>
              </button>
              <p>
                {segment.speaker && <strong>{segment.speaker}: </strong>}
                <HighlightedText query={query} text={segment.text} />
              </p>
            </li>
          ))
        )}
      </ol>
    </section>
  )
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const trimmedQuery = query.trim()

  if (!trimmedQuery) {
    return text
  }

  const lowerText = text.toLowerCase()
  const lowerQuery = trimmedQuery.toLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let matchIndex = lowerText.indexOf(lowerQuery)

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex))
    }

    parts.push(<mark key={`${matchIndex}-${lowerQuery}`}>{text.slice(matchIndex, matchIndex + trimmedQuery.length)}</mark>)
    cursor = matchIndex + trimmedQuery.length
    matchIndex = lowerText.indexOf(lowerQuery, cursor)
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }

  return <>{parts}</>
}

function EmptyState() {
  return (
    <section className="empty-panel reveal">
      <div className="empty-orbit">
        <Icon name="play" size={22} filled />
      </div>
      <h2>Paste a video to begin.</h2>
      <p>
        ChapterLens will transcribe the audio, identify sections, summarize the content, and keep Q&A grounded in
        timestamped transcript evidence.
      </p>
    </section>
  )
}

function QaTurnView({ turn, onSelectCitation }: { turn: QaTurn; onSelectCitation: (startSeconds: number) => void }) {
  return (
    <article className="qa-turn">
      <p className="question">{turn.question}</p>
      {turn.error && (
        <div className="qa-error">
          <Icon name="alert" size={16} />
          {turn.error}
        </div>
      )}
      {!turn.response && !turn.error && (
        <div className="qa-pending">
          <Icon name="loader" className="spin" size={16} />
          Searching transcript context
        </div>
      )}
      {turn.response && (
        <div className="answer-stack">
          <section>
            <h3>Reasoning</h3>
            <p>{turn.response.reasoning}</p>
            <div className="citation-list">
              {turn.response.citations.map((citation) => (
                <CitationButton
                  citation={citation}
                  key={`${citation.timestamp}-${citation.text.slice(0, 20)}`}
                  onSelectCitation={onSelectCitation}
                />
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

function CitationButton({
  citation,
  onSelectCitation,
}: {
  citation: Citation
  onSelectCitation: (startSeconds: number) => void
}) {
  return (
    <button
      className="citation-card"
      type="button"
      aria-label={`Open citation at ${citation.timestamp}`}
      onClick={() => onSelectCitation(citation.startSeconds)}
    >
      <span>{citation.timestamp}</span>
      <p>{citation.text}</p>
    </button>
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

function transcriptDomId(segmentId: string): string {
  return `transcript-segment-${segmentId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function downloadText(filename: string, mimeType: string, content: string): void {
  const blob = new Blob([content], { type: mimeType })
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = href
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(href)
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
