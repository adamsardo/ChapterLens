import { ApiError } from './errors'

const YOUTUBE_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/

export type NormalizedYouTubeUrl = {
  videoId: string
  normalizedUrl: string
}

export function normalizeYouTubeUrl(input: string): NormalizedYouTubeUrl {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new ApiError(400, 'INVALID_URL', 'Paste a YouTube video URL to analyze.')
  }

  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  let url: URL
  try {
    url = new URL(withProtocol)
  } catch {
    throw new ApiError(400, 'INVALID_URL', 'That does not look like a valid URL.')
  }

  const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '')
  let videoId: string | null = null

  if (host === 'youtu.be') {
    videoId = url.pathname.split('/').filter(Boolean)[0] ?? null
  }

  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const pathParts = url.pathname.split('/').filter(Boolean)
    if (url.pathname === '/watch') {
      videoId = url.searchParams.get('v')
    } else if (['shorts', 'embed', 'live'].includes(pathParts[0] ?? '')) {
      videoId = pathParts[1] ?? null
    }
  }

  if (!videoId || !YOUTUBE_ID_PATTERN.test(videoId)) {
    throw new ApiError(
      400,
      'INVALID_YOUTUBE_URL',
      'Use a YouTube video URL such as youtube.com/watch?v=... or youtu.be/...',
    )
  }

  return {
    videoId,
    normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
  }
}
