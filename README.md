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
  - LLM-generated minutes (`gemini-2.5-flash` by default).
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
| `REDIS_URL` | Multi-instance live-share fanout (optional) | no |

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

## API reference

All routes are Next.js App Router handlers under `app/api/`. Request/response shapes are typed in [`lib/contracts.ts`](lib/contracts.ts) — names like `CreateSessionBody`, `SegmentDTO` below refer to that file.

### Auth

NextAuth (Auth.js v5) — JWT session, providers `google` + `dev-login` (the latter gated on `ALLOW_DEV_LOGIN=1` outside of NODE_ENV=development). `middleware.ts` redirects unauthenticated `/dashboard/*` requests to `/login`. Routes resolve the user via `auth()`; legacy helpers (`lib/dev-user.ts`) still exist as a fallback when `ALLOW_DEV_USER_FALLBACK=1`, but Wave 2.1 replaced every prod route with `withAuth()`. Live-share viewer is intentionally public (token in URL).

### Recording / transcription

| Method | Path | Body / Query | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/soniox-token` | `SonioxTokenBody` | `{ token, expiresAt }` — short-lived Soniox temporary key |
| `GET` | `/api/transcription/sessions` | `ListSessionsQuery` | `PaginatedResponse<SessionDTO>` |
| `POST` | `/api/transcription/sessions` | `CreateSessionBody` | `SessionDTO` |
| `GET` | `/api/transcription/sessions/[id]` | — | `SessionDTO` |
| `PATCH` | `/api/transcription/sessions/[id]` | `UpdateSessionBody` | `SessionDTO` |
| `DELETE` | `/api/transcription/sessions/[id]` | — | `{ ok: true }` |
| `GET` | `/api/transcription/sessions/[id]/segments` | — | `{ items: SegmentDTO[] }` |
| `POST` | `/api/transcription/sessions/[id]/segments` | `BulkCreateSegmentsBody` | `{ items: SegmentDTO[] }` (upsert by `segmentIndex`) |
| `PATCH` | `/api/transcription/segments/[id]` | `UpdateSegmentBody` | `SegmentDTO` |
| `DELETE` | `/api/transcription/segments/[id]` | — | `{ ok: true }` |
| `GET` | `/api/transcription/sessions/[id]/speakers` | — | `SpeakerNameDTO[]` |
| `POST` | `/api/transcription/sessions/[id]/speakers` | `UpdateSpeakerNameBody` | `SpeakerNameDTO` |
| `POST` | `/api/sessions/[id]/retranscribe` | — | Kicks off a re-run of ASR against the stored audio |
| `GET` | `/api/sessions/[id]/export` | `?format=md|docx|srt|vtt` | File download |

### Audio upload

Chunked upload — `MediaRecorder` produces webm/opus blobs every 3 s; each is presigned and uploaded directly to storage, then finalized into a single concatenated file.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/audio/chunk-presign` | `ChunkPresignBody` | `ChunkPresignResponse` (includes `storageKey`) |
| `PUT` | `/api/audio/upload-chunk` | raw bytes | for local storage driver only — S3 PUTs go straight to the bucket |
| `POST` | `/api/audio/chunk-record` | `ChunkRecordBody` | `{ ok: true }` — records the chunk in DB |
| `POST` | `/api/audio/finalize` | `FinalizeAudioBody` | `FinalizeAudioResponse` — concatenates chunks into the final blob |
| `GET` | `/api/audio/status` | `?sessionId=` | `AudioStatusResponse` |
| `GET` | `/api/audio/file/[...path]` | — | Streams the audio bytes (for local storage driver) |

### Translation

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/translate` | `TranslateBody` | `TranslateResp` — server-side fallback for cloud-mode translation |

The `local` translation mode never hits this route — Chrome's on-device model runs entirely in the browser.

### Live share

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/live-share` | `{ sessionId }` | `{ token, url }` — mints a public viewer token |
| `GET` | `/api/live-share/[token]` | — | SSE stream (`joined`, `utterance`, `segment` events). Public; no auth. |
| `POST` | `/api/live-share/[token]/push` | `{ type, ... }` | Host-only. Pushes utterance/segment updates to subscribers. |

### Minutes (LLM-generated session summary)

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/sessions/[id]/minutes` | — | `MinutesDTO` or `null` |
| `POST` | `/api/sessions/[id]/minutes/generate` | `GenerateMinutesBody` | `MinutesDTO` — one-shot generation |
| `POST` | `/api/sessions/[id]/minutes/stream` | `GenerateMinutesBody` | SSE stream of `MinutesStreamEvent` — section-by-section as the LLM produces them |

### Chat over transcript

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/chat/sessions` | — | `ChatSessionDTO[]` |
| `POST` | `/api/chat/sessions` | `CreateChatSessionBody` | `ChatSessionDTO` |
| `GET` | `/api/chat/sessions/[id]` | — | `ChatSessionDTO & { messages: ChatMessageDTO[] }` |
| `PATCH` | `/api/chat/sessions/[id]` | `{ title }` | `ChatSessionDTO` |
| `DELETE` | `/api/chat/sessions/[id]` | — | `{ ok: true }` |
| `POST` | `/api/chat` | `ChatRequestBody` | Vercel AI SDK streaming response |
| `POST` | `/api/chat/upload` | multipart | uploads an attachment for context |
| `GET` | `/api/chat/quota` | — | `{ used, limit }` |

### Folders + documents (vocab extraction)

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/folders` | — | `FolderDTO[]` |
| `POST` | `/api/folders` | `CreateFolderBody` | `FolderDTO` |
| `GET` | `/api/folders/[id]` | — | `FolderDTO` |
| `PATCH` | `/api/folders/[id]` | `UpdateFolderBody` | `FolderDTO` |
| `DELETE` | `/api/folders/[id]` | — | `{ ok: true }` |
| `GET` | `/api/folders/[id]/documents` | — | `DocumentDTO[]` |
| `POST` | `/api/folders/[id]/documents` | `DocumentPresignBody` | `DocumentPresignResponse` |
| `POST` | `/api/folders/[id]/documents/confirm` | `DocumentConfirmBody` | `DocumentDTO` |
| `DELETE` | `/api/folders/[id]/documents/[docId]` | — | `{ ok: true }` |
| `POST` | `/api/folders/[id]/documents/[docId]/extract-terms` | — | `ExtractTermsResponse` — LLM term extraction |

### Flashcards (SM-2 SRS)

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/flashcards` | — | `FlashcardDTO[]` |
| `POST` | `/api/flashcards` | `CreateFlashcardBody` | `FlashcardDTO` |
| `PATCH` | `/api/flashcards/[id]` | `{ front?, back? }` | `FlashcardDTO` |
| `DELETE` | `/api/flashcards/[id]` | — | `{ ok: true }` |
| `POST` | `/api/flashcards/[id]/review` | `FlashcardReviewBody` | `FlashcardDTO` (updated SM-2 fields) |
| `GET` | `/api/flashcards/due` | — | Cards whose `nextReviewAt <= now` |
| `POST` | `/api/flashcards/recommend` | `FlashcardRecommendBody` | `FlashcardRecommendResponse` — LLM suggests cards from a session |
| `GET` | `/api/flashcards/source-sessions` | — | Sessions that have any flashcards derived from them |

### Polls / live audience

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/polls` | — | Polls for the dev user |
| `POST` | `/api/polls` | `{ sessionId, question, options[] }` | created poll |
| `POST` | `/api/polls/[id]/vote` | `{ optionId }` | updated tallies |

### Misc

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/sessions/[id]/bookmarks` | — | `BookmarkDTO[]` |
| `POST` | `/api/sessions/[id]/bookmarks` | `CreateBookmarkBody` | `BookmarkDTO` |
| `PATCH` | `/api/bookmarks/[id]` | `UpdateBookmarkBody` | `BookmarkDTO` |
| `DELETE` | `/api/bookmarks/[id]` | — | `{ ok: true }` |
| `GET` | `/api/search` | `?q=` | Cross-session full-text hits |
| `POST` | `/api/lookup` | `{ word, context? }` | Inline dictionary lookup (LLM-backed) |
| `GET` | `/api/user/settings` | — | `{ settings: {...} }` (JSON blob on User row) |
| `PATCH` | `/api/user/settings` | partial settings | merged settings |
| `GET` | `/api/invite/list` | — | The dev user's invite stats |

### Backend libs (`lib/`)

Most routes are thin adapters around domain modules:

```
lib/
  asr/                  Soniox provider — token minting, model defaults
  audio/                Recorder (browser) + worklet message protocol
  translation/          Chrome local + cloud (Gemini / passthrough) translators
  llm/                  Gemini + Anthropic adapters behind LLMProvider iface
  storage/              local-filesystem + S3 implementations of StorageProvider
  document-parser/      pdf-parse, mammoth, officeparser dispatch
  export/               MD / DOCX / SRT / VTT serializers
  live-share/           in-memory pub/sub broadcaster for SSE
  prompts/              LLM prompt templates (minutes, terms, flashcards, chat)
  api/dto.ts            Prisma row → DTO converters
  db.ts                 PrismaClient singleton
  dev-user.ts           Auth resolution + ALLOW_DEV_USER_FALLBACK legacy shim
  quota.ts              Per-user monthly recording / daily chat limits
  contracts.ts          All TypeScript types shared by routes + browser code
```

## Deployment

The recommended Phase 1 production stack is **Vercel + Neon Postgres + Cloudflare R2 + Upstash Redis** — all four have generous free tiers and slot straight into the codebase as-is. Once keys are filled in, deployment is one `git push` (Vercel deploys via its GitHub integration).

See [`.env.production.example`](./.env.production.example) for the full list of variables you'll need to paste into Vercel.

### 1. Neon (Postgres)

1. Sign up at [neon.tech](https://neon.tech) (free tier is enough for Phase 1).
2. Create a project — pick a region close to your Vercel deployment.
3. Copy the pooled connection string (with `sslmode=require`) shown on the project page. This is your `DATABASE_URL`.
4. Provision the schema once from your laptop:
   ```bash
   DATABASE_URL="postgresql://...neon.tech/...?sslmode=require" npm run db:push
   ```
   `db:push` only needs to run once per schema change — Vercel deploys will not run migrations automatically.

### 2. Cloudflare R2 (audio + document storage)

1. Sign up at [cloudflare.com](https://cloudflare.com) → R2 (no card required for the free tier).
2. Create a bucket named **`voice-project`** in a region near your Vercel deployment.
3. Under **R2 → Manage API tokens**, create a token with **Object Read & Write** scoped to the `voice-project` bucket. Copy the Access Key ID + Secret.
4. Fill in `S3_*` in your Vercel env:
   - `S3_ENDPOINT` — `https://<account_id>.r2.cloudflarestorage.com` (shown on the bucket page)
   - `S3_REGION` — `auto`
   - `S3_BUCKET` — `voice-project`
   - `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` — from step 3
   - `S3_PUBLIC_BASE` — either the R2 public dev URL (`https://pub-<hash>.r2.dev`) or a custom domain CNAMEd to the bucket
5. Set `STORAGE_DRIVER="s3"`.

### 3. Upstash Redis (live-share fan-out)

The in-memory `lib/live-share/broadcaster.ts` only works inside a single Node process. On Vercel each function invocation can land on a different container, so live-share viewers won't see updates from the host unless they happen to be on the same instance. Redis pub/sub fixes that.

1. Sign up at [upstash.com](https://upstash.com) (free tier is fine).
2. Create a Redis database — pick the same region as your Vercel deployment if possible.
3. Copy the **TLS** connection URL (it starts with `rediss://default:<password>@<host>:<port>`). This is your `REDIS_URL`.

Redis is technically optional — without it, live-share still works for viewers attached to the same instance as the host, which is fine for local dev. Set `REDIS_URL=""` to skip.

### 4. Vercel

1. Push this repo to GitHub.
2. In Vercel: **Add New Project** → import the repo. Framework auto-detects as Next.js.
3. Open **Settings → Environment Variables** and paste every variable from `.env.production.example` (filled with the values from steps 1–3 above).
4. Click **Deploy**. The first build takes about 2 minutes.

CI (`.github/workflows/ci.yml`) runs typecheck + lint + build on every PR — these pass before Vercel even gets the deploy hook.

### 5. Public live-share URL

Once a host clicks **实时分享** on a session, the response contains a token. The viewer URL is:

```
https://your-app.vercel.app/share/live/<token>
```

Anyone with the URL can read the live transcript over SSE — no login. Tokens are scoped to one session and cannot be revoked in Phase 1, so treat them like API keys.

### Current limits

> **Auth shipped, billing pending.** NextAuth (Google + dev-login) is live as of Phase 2 Wave 2.1 — every recording / chat / vocab row is scoped to `user.id` and `middleware.ts` blocks anonymous access to `/dashboard/*`. Plan + Subscription tables also exist and quota enforcement (120 rec-min/month, 20 chat/day on Free) is wired in.
>
> What's **not** done yet: Stripe checkout + webhook (Wave 2.2). Upgrading a user to Business today requires manually editing the `Subscription` row in Postgres. Invite codes + Mixpanel are Wave 2.3.

## Notes

- The default LLM model IDs in `.env.example` point at Gemini Flash for cost — swap to Claude / a larger Gemini if you want better minutes / chat quality.
- `lib/dev-user.ts` still exists as an `ALLOW_DEV_USER_FALLBACK=1`-gated fallback for legacy smoke tests; production routes resolve users via `auth()`.
- Auto-direction translation only triggers when exactly one of source/target is CJK. For JA↔ZH the configured direction is used as-is.
