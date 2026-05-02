import { describe, expect, it } from 'vitest'
import { mergeDiarizedTranscriptions } from '../server/services/openai'

describe('OpenAI transcription helpers', () => {
  it('offsets chunked transcript segments back onto the full video timeline', () => {
    const transcript = mergeDiarizedTranscriptions([
      {
        startSeconds: 0,
        index: 0,
        response: {
          text: 'The host introduces the lesson.',
          segments: [{ start: 2, end: 8, text: 'The host introduces the lesson.' }],
        },
      },
      {
        startSeconds: 1_200,
        index: 1,
        response: {
          text: 'The second section covers transcript Q&A.',
          segments: [{ start: 3, end: 12, text: 'The second section covers transcript Q&A.' }],
        },
      },
    ])

    expect(transcript.text).toBe('The host introduces the lesson. The second section covers transcript Q&A.')
    expect(transcript.segments).toEqual([
      expect.objectContaining({
        startSeconds: 2,
        endSeconds: 8,
        timestamp: '00:00:02',
      }),
      expect.objectContaining({
        startSeconds: 1_203,
        endSeconds: 1_212,
        timestamp: '00:20:03',
      }),
    ])
  })
})
