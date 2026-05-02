import { describe, expect, it } from 'vitest'
import type { TranscriptSegment } from '../shared/types'
import { buildTranscriptChunks, retrieveRelevantChunks } from '../server/lib/retrieval'

const segments: TranscriptSegment[] = [
  {
    id: 'a',
    startSeconds: 0,
    endSeconds: 10,
    timestamp: '00:00:00',
    text: 'The video opens with product positioning and the main premise.',
  },
  {
    id: 'b',
    startSeconds: 10,
    endSeconds: 25,
    timestamp: '00:00:10',
    text: 'The speaker explains the pricing model and cost tradeoffs.',
  },
  {
    id: 'c',
    startSeconds: 25,
    endSeconds: 45,
    timestamp: '00:00:25',
    text: 'The conclusion recaps implementation details.',
  },
]

describe('retrieval helpers', () => {
  it('creates timestamped transcript chunks', () => {
    const chunks = buildTranscriptChunks(segments, 80)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].timestamp).toBe('00:00:00')
    expect(chunks[0].text).toContain('[00:00:00]')
  })

  it('returns the most similar chunks first', () => {
    const chunks = buildTranscriptChunks(segments, 70)
    const retrieved = retrieveRelevantChunks(
      chunks,
      [
        [1, 0],
        [0, 1],
        [0, 0],
      ],
      [0, 1],
      1,
    )

    expect(retrieved[0].text).toContain('pricing')
  })
})
