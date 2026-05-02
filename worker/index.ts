import { Container, getContainer } from '@cloudflare/containers'

interface Env {
  CHAPTERLENS_CONTAINER: DurableObjectNamespace<ChapterLensContainer>
  OPENAI_API_KEY: string
  OPENAI_TRANSCRIPTION_MODEL: string
  OPENAI_TEXT_MODEL: string
  OPENAI_EMBEDDING_MODEL: string
  TRANSCRIPTION_CONCURRENCY: string
  AUDIO_CHUNK_SECONDS: string
  AUDIO_BITRATE: string
  AUDIO_SAMPLE_RATE: string
  CHAPTER_SUMMARIES_ENABLED: string
}

export class ChapterLensContainer extends Container<Env> {
  defaultPort = 8787
  sleepAfter = '20m'
  enableInternet = true
  envVars = {
    API_HOST: '0.0.0.0',
    API_PORT: '8787',
    CHAPTERLENS_CACHE_DIR: '/tmp/chapterlens-cache',
    NODE_ENV: 'production',
    OPENAI_API_KEY: this.env.OPENAI_API_KEY,
    OPENAI_TRANSCRIPTION_MODEL: this.env.OPENAI_TRANSCRIPTION_MODEL,
    OPENAI_TEXT_MODEL: this.env.OPENAI_TEXT_MODEL,
    OPENAI_EMBEDDING_MODEL: this.env.OPENAI_EMBEDDING_MODEL,
    TRANSCRIPTION_CONCURRENCY: this.env.TRANSCRIPTION_CONCURRENCY,
    AUDIO_CHUNK_SECONDS: this.env.AUDIO_CHUNK_SECONDS,
    AUDIO_BITRATE: this.env.AUDIO_BITRATE,
    AUDIO_SAMPLE_RATE: this.env.AUDIO_SAMPLE_RATE,
    CHAPTER_SUMMARIES_ENABLED: this.env.CHAPTER_SUMMARIES_ENABLED,
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.CHAPTERLENS_CONTAINER).fetch(request)
  },
} satisfies ExportedHandler<Env>
