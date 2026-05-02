import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AnalysisListItem, AnalysisRecord } from '../../shared/types'

export async function writeAnalysisRecord(record: AnalysisRecord): Promise<void> {
  if (isLibraryDisabled()) {
    return
  }

  await mkdir(analysisLibraryPath(), { recursive: true })
  await writeFile(analysisRecordPath(record.sessionId), JSON.stringify(record, null, 2))
}

export async function readAnalysisRecord(sessionId: string): Promise<AnalysisRecord | null> {
  if (isLibraryDisabled() || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return null
  }

  try {
    const raw = await readFile(analysisRecordPath(sessionId), 'utf8')
    return JSON.parse(raw) as AnalysisRecord
  } catch {
    return null
  }
}

export async function listAnalysisRecords(limit = 12): Promise<AnalysisRecord[]> {
  if (isLibraryDisabled()) {
    return []
  }

  try {
    const directory = analysisLibraryPath()
    const files = (await readdir(directory)).filter((file) => file.endsWith('.json'))
    const records = await Promise.all(
      files.map(async (file) => {
        try {
          const raw = await readFile(join(directory, file), 'utf8')
          return JSON.parse(raw) as AnalysisRecord
        } catch {
          return null
        }
      }),
    )

    return records
      .filter((record): record is AnalysisRecord => Boolean(record?.sessionId && record.video?.title))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit)
  } catch {
    return []
  }
}

export function toAnalysisListItem(record: AnalysisRecord): AnalysisListItem {
  return {
    sessionId: record.sessionId,
    video: record.video,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.summary ? { summaryPreview: previewText(record.summary) } : {}),
    chapterCount: record.chapters?.length ?? 0,
    transcriptSegmentCount: record.transcript.segments.length,
    qaReady: record.qaReady,
  }
}

function analysisRecordPath(sessionId: string): string {
  return join(analysisLibraryPath(), `${sessionId}.json`)
}

function analysisLibraryPath(): string {
  return join(cacheRoot(), 'analyses')
}

function cacheRoot(): string {
  return process.env.CHAPTERLENS_CACHE_DIR ?? join(process.cwd(), '.chapterlens-cache')
}

function isLibraryDisabled(): boolean {
  return process.env.CHAPTERLENS_CACHE_DISABLED === '1' || process.env.CHAPTERLENS_LIBRARY_DISABLED === '1'
}

function previewText(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed
}
