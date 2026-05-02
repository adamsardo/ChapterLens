import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { execa, type Options } from 'execa'
import type { DependencyStatus, VideoMetadata } from '../../shared/types'
import { ApiError, toErrorMessage } from '../lib/errors'
import { normalizeYouTubeUrl } from '../lib/youtube'

type CommandRunner = (file: string, args: string[], options?: Options) => Promise<{ stdout: string }>
type SpawnOptions = {
  env?: NodeJS.ProcessEnv
  timeout?: number
}
type SpawnedProcess = {
  stdin?: Writable
  stdout?: Readable
  wait: () => Promise<void>
  kill: () => void
}
type ProcessSpawner = (file: string, args: string[], options?: SpawnOptions) => SpawnedProcess

const TOOL_PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? ''].join(':')
const DEFAULT_TRANSCRIPTION_CHUNK_SECONDS = 300
const MAX_TRANSCRIPTION_CHUNK_SECONDS = 1_200

export type AudioChunk = {
  path: string
  startSeconds: number
  index: number
}

export type AudioExtractionOptions = {
  onChunk?: (chunk: AudioChunk) => void
  onProgress?: (detail: string) => void
}

export type ExtractedAudio = {
  path: string
  chunks: AudioChunk[]
  cleanup: () => Promise<void>
}

export type VideoService = {
  checkDependencies: () => Promise<DependencyStatus[]>
  assertDependencies: () => Promise<void>
  getMetadata: (url: string) => Promise<VideoMetadata>
  extractAudio: (url: string, options?: AudioExtractionOptions) => Promise<ExtractedAudio>
}

type YtDlpMetadata = {
  id?: string
  title?: string
  channel?: string
  uploader?: string
  duration?: number
  thumbnail?: string
  webpage_url?: string
}

export class YtDlpVideoService implements VideoService {
  private readonly runner: CommandRunner
  private readonly spawner: ProcessSpawner

  constructor(
    runner: CommandRunner = async (file, args, options) => {
      const result = await execa(file, args, options)
      return { stdout: typeof result.stdout === 'string' ? result.stdout : '' }
    },
    spawner: ProcessSpawner = spawnProcess,
  ) {
    this.runner = runner
    this.spawner = spawner
  }

  async checkDependencies(): Promise<DependencyStatus[]> {
    const checks = await Promise.all([this.checkBinary('yt-dlp'), this.checkBinary('ffmpeg')])
    return checks
  }

  async assertDependencies(): Promise<void> {
    const dependencies = await this.checkDependencies()
    const missing = dependencies.filter((dependency) => !dependency.ok)

    if (missing.length > 0) {
      throw new ApiError(
        503,
        'DEPENDENCY_MISSING',
        'Install yt-dlp and ffmpeg before analyzing real YouTube videos.',
        missing,
      )
    }
  }

  async getMetadata(inputUrl: string): Promise<VideoMetadata> {
    const { normalizedUrl, videoId } = normalizeYouTubeUrl(inputUrl)

    try {
      const { stdout } = await this.runner(
        'yt-dlp',
        ['--no-playlist', '--dump-single-json', '--skip-download', normalizedUrl],
        { timeout: 45_000, env: { ...process.env, PATH: TOOL_PATH } },
      )
      const metadata = JSON.parse(stdout) as YtDlpMetadata

      return {
        id: metadata.id ?? videoId,
        title: metadata.title ?? 'Untitled YouTube video',
        channel: metadata.channel ?? metadata.uploader,
        durationSeconds: metadata.duration,
        thumbnailUrl: metadata.thumbnail,
        webpageUrl: metadata.webpage_url ?? normalizedUrl,
      }
    } catch (error) {
      throw new ApiError(502, 'VIDEO_METADATA_FAILED', 'Could not read metadata for this YouTube video.', {
        cause: toErrorMessage(error),
      })
    }
  }

  async extractAudio(inputUrl: string, options: AudioExtractionOptions = {}): Promise<ExtractedAudio> {
    const { normalizedUrl } = normalizeYouTubeUrl(inputUrl)
    const directory = await mkdtemp(join(tmpdir(), 'chapterlens-'))
    let emittedChunks = 0

    try {
      const wrappedOptions = {
        ...options,
        onChunk: (chunk: AudioChunk) => {
          emittedChunks += 1
          options.onChunk?.(chunk)
        },
      }
      const chunks =
        process.env.AUDIO_STREAMING_DISABLED === '1'
          ? await this.downloadAndSplitAudio(normalizedUrl, directory, wrappedOptions)
          : await this.streamAudioChunks(normalizedUrl, directory, wrappedOptions).catch(async (error) => {
              if (emittedChunks > 0) {
                throw error
              }

              options.onProgress?.('Streaming audio failed; falling back to file extraction')
              return this.downloadAndSplitAudio(normalizedUrl, directory, wrappedOptions)
            })

      return {
        path: directory,
        chunks,
        cleanup: () => rm(directory, { recursive: true, force: true }),
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw new ApiError(502, 'AUDIO_EXTRACTION_FAILED', 'Could not extract audio from this YouTube video.', {
        cause: toErrorMessage(error),
      })
    }
  }

  private async streamAudioChunks(
    normalizedUrl: string,
    directory: string,
    options: AudioExtractionOptions,
  ): Promise<AudioChunk[]> {
    const chunkDirectory = join(directory, 'chunks')
    const chunkTemplate = join(chunkDirectory, 'chunk-%03d.mp3')
    const chunkSeconds = getAudioChunkSeconds()
    const emitted = new Set<string>()
    const chunks: AudioChunk[] = []
    let emitQueue = Promise.resolve()

    await mkdir(chunkDirectory, { recursive: true })

    const ytDlp = this.spawner(
      'yt-dlp',
      [
        '--no-playlist',
        '--no-warnings',
        '--format',
        'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
        '--output',
        '-',
        normalizedUrl,
      ],
      { timeout: 900_000, env: { ...process.env, PATH: TOOL_PATH } },
    )
    const ffmpeg = this.spawner(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-map',
        '0:a:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        getAudioSampleRate(),
        '-b:a',
        getAudioBitrate(),
        '-f',
        'segment',
        '-segment_time',
        String(chunkSeconds),
        '-reset_timestamps',
        '1',
        '-segment_format',
        'mp3',
        chunkTemplate,
      ],
      { timeout: 900_000, env: { ...process.env, PATH: TOOL_PATH } },
    )

    if (ytDlp.stdout && ffmpeg.stdin) {
      ytDlp.stdout.pipe(ffmpeg.stdin)
    }

    const scheduleEmit = (includeLast: boolean) => {
      emitQueue = emitQueue.then(() => emitClosedChunks(chunkDirectory, chunkSeconds, emitted, chunks, includeLast, options))
      return emitQueue
    }

    const timer = setInterval(() => {
      void scheduleEmit(false)
    }, getChunkPollMs())

    try {
      await Promise.all([ytDlp.wait(), ffmpeg.wait()])
    } catch (error) {
      ytDlp.kill()
      ffmpeg.kill()
      throw error
    } finally {
      clearInterval(timer)
      await scheduleEmit(true)
    }

    if (chunks.length === 0) {
      throw new Error('ffmpeg finished without producing audio chunks')
    }

    return chunks.sort((a, b) => a.index - b.index)
  }

  private async downloadAndSplitAudio(
    normalizedUrl: string,
    directory: string,
    options: AudioExtractionOptions,
  ): Promise<AudioChunk[]> {
    const outputTemplate = join(directory, 'audio.%(ext)s')

    await this.runner(
      'yt-dlp',
      [
        '--no-playlist',
        '--extract-audio',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '5',
        '--output',
        outputTemplate,
        normalizedUrl,
      ],
      { timeout: 900_000, env: { ...process.env, PATH: TOOL_PATH } },
    )

    const files = await readdir(directory)
    const audioFile = files.find((file) => /\.(mp3|m4a|webm|wav|ogg)$/i.test(file))

    if (!audioFile) {
      throw new Error('yt-dlp finished without producing an audio file')
    }

    return this.splitAudio(join(directory, audioFile), directory, options)
  }

  private async splitAudio(audioPath: string, directory: string, options: AudioExtractionOptions): Promise<AudioChunk[]> {
    const chunkDirectory = join(directory, 'chunks')
    const chunkTemplate = join(chunkDirectory, 'chunk-%03d.mp3')
    const chunkSeconds = getAudioChunkSeconds()

    await mkdir(chunkDirectory, { recursive: true })
    await this.runner(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        audioPath,
        '-map',
        '0:a:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        getAudioSampleRate(),
        '-b:a',
        getAudioBitrate(),
        '-f',
        'segment',
        '-segment_time',
        String(chunkSeconds),
        '-reset_timestamps',
        '1',
        '-c',
        'copy',
        chunkTemplate,
      ],
      { timeout: 900_000, env: { ...process.env, PATH: TOOL_PATH } },
    )

    const chunkFiles = (await readdir(chunkDirectory))
      .filter((file) => /^chunk-\d+\.mp3$/i.test(file))
      .sort((a, b) => a.localeCompare(b))

    if (chunkFiles.length === 0) {
      throw new Error('ffmpeg finished without producing audio chunks')
    }

    return chunkFiles.map((file, index) => ({
      path: join(chunkDirectory, file),
      startSeconds: index * chunkSeconds,
      index,
    })).map((chunk) => {
      options.onChunk?.(chunk)
      return chunk
    })
  }

  private async checkBinary(name: 'yt-dlp' | 'ffmpeg'): Promise<DependencyStatus> {
    try {
      const versionArgs = name === 'ffmpeg' ? ['-version'] : ['--version']
      const { stdout } = await this.runner(name, versionArgs, {
        timeout: 10_000,
        env: { ...process.env, PATH: TOOL_PATH },
      })
      return {
        name,
        ok: true,
        detail: stdout.split('\n')[0] || 'available',
      }
    } catch {
      return {
        name,
        ok: false,
        detail: `${name} was not found on PATH`,
      }
    }
  }
}

async function emitClosedChunks(
  chunkDirectory: string,
  chunkSeconds: number,
  emitted: Set<string>,
  chunks: AudioChunk[],
  includeLast: boolean,
  options: AudioExtractionOptions,
): Promise<void> {
  const chunkFiles = (await readdir(chunkDirectory).catch(() => []))
    .filter((file) => /^chunk-\d+\.mp3$/i.test(file))
    .sort((a, b) => a.localeCompare(b))
  const readyFiles = includeLast ? chunkFiles : chunkFiles.slice(0, -1)

  for (const file of readyFiles) {
    if (emitted.has(file)) {
      continue
    }

    const match = file.match(/^chunk-(\d+)\.mp3$/i)
    const index = match ? Number(match[1]) : chunks.length
    const chunk = {
      path: join(chunkDirectory, file),
      startSeconds: index * chunkSeconds,
      index,
    }

    emitted.add(file)
    chunks.push(chunk)
    options.onChunk?.(chunk)
  }
}

function spawnProcess(file: string, args: string[], options: SpawnOptions = {}): SpawnedProcess {
  const child = spawn(file, args, {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderr: Buffer[] = []
  let timeout: NodeJS.Timeout | undefined

  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

  if (options.timeout && options.timeout > 0) {
    timeout = setTimeout(() => {
      child.kill('SIGTERM')
    }, options.timeout)
  }

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    wait: async () => {
      const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null]
      if (timeout) {
        clearTimeout(timeout)
      }

      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        throw new Error(`${file} failed${signal ? ` with ${signal}` : ''}${detail ? `: ${detail}` : ''}`)
      }
    },
    kill: () => {
      if (!child.killed) {
        child.kill('SIGTERM')
      }
    },
  }
}

function getAudioChunkSeconds(): number {
  const configured = Number(process.env.AUDIO_CHUNK_SECONDS)

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_TRANSCRIPTION_CHUNK_SECONDS
  }

  return Math.min(Math.max(Math.floor(configured), 60), MAX_TRANSCRIPTION_CHUNK_SECONDS)
}

function getAudioBitrate(): string {
  return process.env.AUDIO_BITRATE ?? '32k'
}

function getAudioSampleRate(): string {
  return process.env.AUDIO_SAMPLE_RATE ?? '16000'
}

function getChunkPollMs(): number {
  const configured = Number(process.env.AUDIO_CHUNK_POLL_MS)

  if (!Number.isFinite(configured) || configured <= 0) {
    return 500
  }

  return Math.max(25, Math.floor(configured))
}
