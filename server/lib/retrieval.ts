import type { Citation, TranscriptSegment } from '../../shared/types'

export type TranscriptChunk = Citation & {
  id: string
  segmentIds: string[]
  embeddingText: string
}

export function buildTranscriptChunks(segments: TranscriptSegment[], targetCharacters = 900): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = []
  let current: TranscriptSegment[] = []
  let currentLength = 0

  const pushCurrent = () => {
    if (current.length === 0) {
      return
    }

    const first = current[0]
    const last = current[current.length - 1]
    const text = current.map((segment) => `[${segment.timestamp}] ${segment.text}`).join(' ')

    chunks.push({
      id: `chunk-${chunks.length + 1}`,
      timestamp: first.timestamp,
      startSeconds: first.startSeconds,
      endSeconds: last.endSeconds,
      text,
      segmentIds: current.map((segment) => segment.id),
      embeddingText: text,
    })

    current = []
    currentLength = 0
  }

  for (const segment of segments) {
    const nextLength = currentLength + segment.text.length

    if (current.length > 0 && nextLength > targetCharacters) {
      pushCurrent()
    }

    current.push(segment)
    currentLength += segment.text.length
  }

  pushCurrent()
  return chunks
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0
  }

  let dot = 0
  let normA = 0
  let normB = 0

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index]
    normA += a[index] * a[index]
    normB += b[index] * b[index]
  }

  if (normA === 0 || normB === 0) {
    return 0
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function retrieveRelevantChunks(
  chunks: TranscriptChunk[],
  embeddings: number[][],
  questionEmbedding: number[],
  limit = 5,
): TranscriptChunk[] {
  return chunks
    .map((chunk, index) => ({
      chunk,
      score: cosineSimilarity(embeddings[index] ?? [], questionEmbedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ chunk }) => chunk)
}
