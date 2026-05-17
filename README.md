# Voice Project

Real-time speech transcription + translation for lectures. A self-hosted clone of [lecsync.com](https://www.lecsync.com) aimed at Chinese students attending English-medium lectures (and vice versa).

Built around **Soniox** for streaming ASR + two-way translation, with an optional **Chrome on-device Translator** path for users who don't want their audio leaving the laptop.

## Features

- **Live transcription + translation** — sentence-level cards stream in as you speak, with translation rendered as the primary text and the source as a muted subtitle.
- **Two translation modes**
  - `local` (default) — Chrome 138+ on-device Translator API, no audio leaves the browser for translation.
  - `cloud` — Soniox's `two_way` translation stream, runs server-side and supports more language pairs.
- **Floating subtitle window** — Document Picture-in-Picture window with a scrolling history of recent utterances, sized + scaled from user settings.
- **Public live-share** — generate a token-gated URL viewers can open with no login to follow the live transcript over SSE.
- **Speaker diarization** — color-coded `Speaker N` chips driven by Soniox's speaker IDs.
- **Auto-direction translation** — speak Chinese while configured for `EN → ZH` and the recorder flips the translator direction on the fly (only when one side is CJK and the other isn't, to avoid JA↔ZH ambiguity).
- **Post-recording artifacts**
  - LLM-generated minutes (`gemini-2.0-flash` by default).
  - Chat over the transcript.
  - Vocabulary lookup + SM-2 flashcards.
  - Polls during the lecture.
- **Audio upload pipeline** — chunked `webm/opus` uploads via presigned PUT, concatenated server-side for replay.

## Tech stack

- **Framework**: Next.js 15 (App Router, Turbopack), React 19
- **DB**: Postgres 16 via Prisma 6 (cuid ids)
- **ASR**: Soniox `stt-rt-v4` over WebSocket
- **Translation**: Chrome Translator API (`window.Translator`) and/or Soniox two-way
- **LLM**: Gemini / Anthropic via Vercel AI SDK
- **Storage**: local filesystem or any S3-compatible (R2, MinIO, etc.)
- **Audio**: `AudioWorklet` for 16 kHz PCM int16 capture, `MediaRecorder` for chunked archive uploads
- **UI**: Tailwind v4 + shadcn-style components on Radix primitives

## Getting started

### Prerequisites

- Node 20+
- Docker (for the bundled Postgres) — or any Postgres 14+
- Chrome 138+ if you want on-device translation. Enable the Translator API at `chrome://flags/#translation-api`.

### Setup

```bash
# 1. install
npm install

# 2. start Postgres (or point DATABASE_URL elsewhere)
npm run db:up

# 3. env
cp .env.example .env
# fill in SONIOX_API_KEY at minimum

# 4. push schema + seed the dev user / sample data
npm run db:push
npm run db:seed

# 5. dev server
npm run dev
```

Open [localhost:3000/dashboard](http://localhost:3000/dashboard).

### Required env

Only `SONIOX_API_KEY` is strictly required for the core record/transcribe loop. Everything else has sensible defaults:

| Var | Purpose | Required |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection | yes |
| `SONIOX_API_KEY` | Streaming ASR + cloud translation | yes |
| `GEMINI_API_KEY` | Minutes, chat, term extraction, flashcards | optional |
| `ANTHROPIC_API_KEY` | Alternative LLM backend | optional |
| `STORAGE_DRIVER` | `local` (default) or `s3` | no |
| `S3_*` | S3-compatible storage when `STORAGE_DRIVER=s3` | only if s3 |
| `LLM_DEFAULT_PROVIDER` | `gemini` or `anthropic` | no |

The local translator path needs no key — it runs entirely in the browser.

## Project layout

```
app/
  (app)/dashboard/       Authenticated app shell (recording, history, etc.)
  api/                   Route handlers (transcription, soniox-token,
                         translate, live-share, minutes, chat, polls, …)
  share/live/[token]/    Public read-only viewer for live shares
components/              UI components (Recorder, FloatingSubtitle, …)
lib/
  audio/recorder.ts      Soniox WS client, AudioWorklet bridge, sentence
                         splitter, Chrome Translator integration
  contracts.ts           Provider interfaces + DTOs (one source of truth)
  providers/             Soniox / Gemini / Claude / storage adapters
prisma/
  schema.prisma          19 tables: Session, Segment, Folder, Document,
                         Flashcard, ChatMessage, LiveShareSession, Poll, …
```

## Key flows

### Recording loop

1. User clicks **新建录音** → POST `/api/transcription/sessions` to create a Session row.
2. POST `/api/soniox-token` mints a short-lived Soniox temporary token.
3. Browser opens `wss://stt-rt.soniox.com/transcribe-websocket` and starts feeding 16 kHz PCM int16 from `AudioWorklet`.
4. Soniox returns frame-snapshots of tokens (finals + pending) with `is_final`, `speaker`, `translation_status`. The recorder maintains a per-speaker `UtteranceBuilder` and emits utterance/segment events to the UI.
5. In parallel, `MediaRecorder` produces `webm/opus` chunks every 3 s, presigned via `/api/audio/chunk-presign` and uploaded directly to storage.
6. On stop, `/api/audio/finalize` concatenates the chunks into one playable file.

### Translation

- **local**: `scheduleLiveTranslate` debounces `window.Translator.translate()` on the in-flight source text (350 ms). On finalize, the segment row gets PATCHed with the translation. Falls back to cloud silently when the on-device model isn't downloaded.
- **cloud**: Soniox's `translation: { type: "two_way", language_a, language_b }` config delivers translation tokens in the same WS frame as the source.

### Live share

1. Host clicks **实时分享** → POST `/api/live-share` mints a token and returns the public viewer URL.
2. Recorder fires every utterance / segment update to `/api/live-share/{token}/push`.
3. Push handler `broadcast()`s the payload to an in-memory channel.
4. Each viewer opens an SSE stream at `/api/live-share/{token}` which replays existing segments on join and subscribes for live events.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server with Turbopack |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | Next lint |
| `npm run db:up` | Start the docker-compose Postgres |
| `npm run db:push` | Push schema without a migration |
| `npm run db:migrate` | Create + apply a new migration |
| `npm run db:studio` | Prisma Studio |
| `npm run db:seed` | Seed dev user + sample data |
| `npm run db:reset` | Drop + recreate the database |

## Notes

- The default LLM model IDs in `.env.example` point at Gemini Flash for cost — swap to Claude / a larger Gemini if you want better minutes / chat quality.
- The dev user is hard-coded (`DEV_USER_EMAIL` in env). Phase 2 will add real auth.
- Auto-direction translation only triggers when exactly one of source/target is CJK. For JA↔ZH the configured direction is used as-is.
