# ChapterLens

Premium local-first YouTube video intelligence app.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

Set `OPENAI_API_KEY` in `.env`, then install the local video tools:

```bash
brew install yt-dlp ffmpeg
```

The web app runs at `http://localhost:5173` and proxies API calls to `http://127.0.0.1:8787`.

## Features

- Validates and normalizes YouTube URLs.
- Extracts audio with `yt-dlp` and `ffmpeg`.
- Streams audio into small mono chunks so transcription can begin before the full download finishes.
- Transcribes audio with OpenAI `gpt-4o-transcribe-diarize`.
- Caches transcripts, embeddings, and insight calls locally in `.chapterlens-cache` for faster retries.
- Generates a summary under 200 words and editorial, title-only timestamped chapters.
- Answers video questions from transcript chunks with timestamp citations.

## Latency knobs

```bash
TRANSCRIPTION_CONCURRENCY=4
AUDIO_CHUNK_SECONDS=300
AUDIO_BITRATE=32k
AUDIO_SAMPLE_RATE=16000
CHAPTER_SUMMARIES_ENABLED=0
```

Use a higher `TRANSCRIPTION_CONCURRENCY` if your OpenAI rate limits allow it. Smaller chunks usually show progress sooner; very small chunks add request overhead.

Set `CHAPTER_SUMMARIES_ENABLED=1` if you want the optional one-sentence chapter descriptions back. The default is title-only chapters in a podcast/YouTube style.

## Checks

```bash
npm run lint
npm run test
npm run build
```
