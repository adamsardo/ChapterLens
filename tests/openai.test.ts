import { describe, expect, it } from 'vitest'
import { hasTranscriptionContent, mergeDiarizedTranscriptions } from '../server/services/openai'

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

  it('ignores empty chunks when other chunks contain transcript text', () => {
    const transcript = mergeDiarizedTranscriptions([
      {
        startSeconds: 0,
        index: 0,
        response: {
          text: '',
          segments: [],
        },
      },
      {
        startSeconds: 300,
        index: 1,
        response: {
          text: 'The second chunk contains the usable transcript.',
          segments: [],
        },
      },
    ])

    expect(transcript.text).toBe('The second chunk contains the usable transcript.')
    expect(transcript.segments).toEqual([
      expect.objectContaining({
        startSeconds: 300,
        timestamp: '00:05:00',
        text: 'The second chunk contains the usable transcript.',
      }),
    ])
  })

  it('detects empty cached transcription responses as unusable', () => {
    expect(hasTranscriptionContent({ text: '', segments: [] })).toBe(false)
    expect(hasTranscriptionContent({ text: '', segments: [{ start: 0, end: 1, text: 'Recovered' }] })).toBe(true)
  })
})
