import { describe, expect, it } from 'vitest'
import { normalizeYouTubeUrl } from '../server/lib/youtube'

describe('normalizeYouTubeUrl', () => {
  it('normalizes watch URLs', () => {
    expect(normalizeYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toEqual({
      videoId: 'dQw4w9WgXcQ',
      normalizedUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    })
  })

  it('normalizes short URLs without a protocol', () => {
    expect(normalizeYouTubeUrl('youtu.be/dQw4w9WgXcQ').normalizedUrl).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    )
  })

  it('normalizes Shorts URLs', () => {
    expect(normalizeYouTubeUrl('https://youtube.com/shorts/dQw4w9WgXcQ').videoId).toBe('dQw4w9WgXcQ')
  })

  it('rejects non-video URLs', () => {
    expect(() => normalizeYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ')).toThrow('YouTube')
  })
})
