import type { Chapter, TranscriptSegment } from './types'

export function formatTimestamp(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const seconds = safeSeconds % 60

  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
}

export function parseTimestamp(timestamp: string): number {
  const parts = timestamp.split(':').map(Number)

  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return 0
  }

  const [hours, minutes, seconds] = parts
  return hours * 3600 + minutes * 60 + seconds
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

export function enforceSummaryLimit(summary: string, maxWords = 200): string {
  const words = summary.trim().split(/\s+/).filter(Boolean)
  if (words.length <= maxWords) {
    return summary.trim()
  }

  return `${words.slice(0, maxWords).join(' ').replace(/[.,;:!?]+$/, '')}.`
}

export function normalizeTranscriptSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments
    .filter((segment) => segment.text.trim().length > 0)
    .sort((a, b) => a.startSeconds - b.startSeconds)
    .map((segment, index) => ({
      ...segment,
      id: segment.id || `segment-${index + 1}`,
      startSeconds: Math.max(0, segment.startSeconds),
      endSeconds: Math.max(segment.startSeconds, segment.endSeconds),
      timestamp: formatTimestamp(segment.startSeconds),
      text: segment.text.trim(),
    }))
}

export function normalizeChapters(
  chapters: Array<{ startSeconds: number; title: string; summary?: string | null }>,
): Chapter[] {
  const seen = new Set<string>()

  return chapters
    .filter((chapter) => chapter.title.trim().length > 0)
    .sort((a, b) => a.startSeconds - b.startSeconds)
    .map((chapter) => {
      const timestamp = formatTimestamp(chapter.startSeconds)
      const key = `${timestamp}-${chapter.title.trim().toLowerCase()}`
      if (seen.has(key)) {
        return null
      }
      seen.add(key)

      return {
        timestamp,
        title: chapter.title.trim(),
        ...(chapter.summary?.trim() ? { summary: chapter.summary.trim() } : {}),
      }
    })
    .filter((chapter): chapter is Chapter => chapter !== null)
}

export function normalizeEditorialChapters(
  chapters: Array<{ startSeconds: number; title: string; summary?: string | null }>,
  options: { includeSummaries?: boolean } = {},
): Chapter[] {
  return normalizeChapters(chapters).map((chapter) => ({
    timestamp: chapter.timestamp,
    title: cleanChapterTitle(chapter.title),
    ...(options.includeSummaries && chapter.summary ? { summary: chapter.summary } : {}),
  }))
}

function cleanChapterTitle(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.?!]+$/g, '')
}
