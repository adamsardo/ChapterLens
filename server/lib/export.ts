import type { AnalysisRecord, ExportFormat, ExportPreset, ExportResponse, TranscriptSegment } from '../../shared/types'
import { formatTimestamp } from '../../shared/time'

export function buildAnalysisExport(
  record: AnalysisRecord,
  preset: ExportPreset,
  format: ExportFormat,
): ExportResponse {
  const extension = format === 'markdown' ? 'md' : 'txt'
  const mimeType = format === 'markdown' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8'
  const filename = `${slugify(record.video.title)}-${preset}.${extension}`

  return {
    filename,
    mimeType,
    content: format === 'markdown' ? buildMarkdown(record, preset) : buildText(record, preset),
  }
}

function buildMarkdown(record: AnalysisRecord, preset: ExportPreset): string {
  const lines = [
    `# ${record.video.title}`,
    '',
    metadataLine(record),
    `- URL: ${record.video.webpageUrl}`,
    `- Analyzed: ${record.createdAt}`,
    '',
  ]

  if (record.summary) {
    lines.push('## Summary', '', record.summary, '')
  }

  if (record.chapters?.length) {
    lines.push('## Chapters', '')
    for (const chapter of record.chapters) {
      lines.push(`- [${chapter.timestamp}] ${chapter.title}${chapter.summary ? ` - ${chapter.summary}` : ''}`)
    }
    lines.push('')
  }

  if (preset === 'full-transcript') {
    lines.push('## Transcript', '')
    lines.push(...record.transcript.segments.map(formatMarkdownSegment))
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

function buildText(record: AnalysisRecord, preset: ExportPreset): string {
  const lines = [
    record.video.title,
    metadataText(record),
    `URL: ${record.video.webpageUrl}`,
    `Analyzed: ${record.createdAt}`,
    '',
  ]

  if (record.summary) {
    lines.push('SUMMARY', record.summary, '')
  }

  if (record.chapters?.length) {
    lines.push('CHAPTERS')
    for (const chapter of record.chapters) {
      lines.push(`[${chapter.timestamp}] ${chapter.title}${chapter.summary ? ` - ${chapter.summary}` : ''}`)
    }
    lines.push('')
  }

  if (preset === 'full-transcript') {
    lines.push('TRANSCRIPT')
    lines.push(...record.transcript.segments.map(formatTextSegment))
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

function metadataLine(record: AnalysisRecord): string {
  const channel = record.video.channel ? `- Channel: ${record.video.channel}` : '- Channel: Unknown'
  const duration = `- Duration: ${formatDuration(record.video.durationSeconds)}`
  const segments = `- Transcript segments: ${record.transcript.segments.length}`
  return [channel, duration, segments].join('\n')
}

function metadataText(record: AnalysisRecord): string {
  return [
    `Channel: ${record.video.channel ?? 'Unknown'}`,
    `Duration: ${formatDuration(record.video.durationSeconds)}`,
    `Transcript segments: ${record.transcript.segments.length}`,
  ].join('\n')
}

function formatMarkdownSegment(segment: TranscriptSegment): string {
  const speaker = segment.speaker ? ` **${segment.speaker}:**` : ''
  return `- [${segment.timestamp}]${speaker} ${segment.text}`
}

function formatTextSegment(segment: TranscriptSegment): string {
  const speaker = segment.speaker ? ` ${segment.speaker}:` : ''
  return `[${segment.timestamp}]${speaker} ${segment.text}`
}

function formatDuration(seconds?: number): string {
  if (!seconds) {
    return 'Unknown'
  }

  return formatTimestamp(seconds)
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)

  return slug || 'chapterlens-export'
}
