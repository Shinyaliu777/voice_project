/**
 * Shared contracts: provider interfaces, API DTOs, recorder types.
 *
 * All six implementation agents target these types. The aim is that
 * providers, API routes, pages, and components can be developed in
 * parallel as long as everyone honors these signatures.
 */

// =========================================================
// 1. ASR provider (Soniox today; the abstraction lets us swap)
// =========================================================

export interface SonioxTokenRequest {
  /** When the temporary key should expire. Default: process.env.SONIOX_TOKEN_TTL_SECONDS */
  expiresInSeconds?: number;
  /** Caller-supplied id to tag the session in Soniox usage logs */
  clientReferenceId?: string;
}
export interface SonioxTokenResponse {
  token: string;
  /** Unix ms */
  expiresAt: number;
}

export interface ASRProvider {
  mintTemporaryToken(req: SonioxTokenRequest): Promise<SonioxTokenResponse>;
}

// =========================================================
// 2. LLM provider (used by minutes generation, chat, term extract, flashcards)
// =========================================================

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMGenerateOptions {
  /** Override the default model for this call */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Hint that we want strict JSON in the response */
  responseFormat?: "text" | "json";
  /** Forwarded as system message if `messages` doesn't start with one */
  system?: string;
  /** Optional abort signal */
  signal?: AbortSignal;
}

export interface LLMProvider {
  /** Single-shot generation, returns the full string */
  generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<string>;
  /** Streaming generation, yields text deltas as they arrive */
  stream(messages: LLMMessage[], options?: LLMGenerateOptions): AsyncIterable<string>;
  /** Human-readable provider name, e.g. "gemini" or "claude" */
  readonly id: string;
}

// =========================================================
// 3. Translation provider
// =========================================================

export interface TranslationRequest {
  text: string;
  sourceLanguage: string; // BCP-47 e.g. "en", "zh", "ja"
  targetLanguage: string;
  /** Custom terminology used to guide the translation */
  terms?: Array<{ term: string; definition?: string }>;
  /** Optional id for logging / dedupe */
  segmentId?: string;
}
export interface TranslationResponse {
  translatedText: string;
  /** Which provider actually produced this — useful for the UI badge */
  translationSource: "chrome-local" | "gemini" | "claude" | "passthrough";
}

export interface TranslationProvider {
  translate(req: TranslationRequest): Promise<TranslationResponse>;
  readonly id: TranslationResponse["translationSource"];
}

// =========================================================
// 4. Storage provider
// =========================================================

export interface StoragePresignRequest {
  key: string;
  contentType: string;
  sizeBytes?: number;
  /** Seconds the presigned URL is valid for (default 600) */
  expiresInSeconds?: number;
}
export interface StoragePresignResponse {
  uploadUrl: string;
  publicUrl: string;
  method: "PUT" | "POST";
  headers?: Record<string, string>;
}
export interface StorageGetRange {
  start: number;
  end: number;
}
export interface StorageGetResponse {
  body: ReadableStream<Uint8Array>;
  contentLength: number;
  contentType?: string;
}

export interface StorageProvider {
  presignPut(req: StoragePresignRequest): Promise<StoragePresignResponse>;
  putStream(
    key: string,
    body: ReadableStream<Uint8Array> | Buffer | Uint8Array,
    contentType: string
  ): Promise<{ publicUrl: string }>;
  getStream(key: string, range?: StorageGetRange): Promise<StorageGetResponse>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Convenience key builders (so the path scheme stays consistent across the app) */
  keyForChunk(sessionId: string, chunkIndex: number, ext: string): string;
  keyForFinalAudio(sessionId: string, ext: string): string;
  keyForFolderDocument(folderId: string, docId: string, ext: string): string;
  /** Public URL the browser can use to fetch this key */
  publicUrlFor(key: string): string;
}

// =========================================================
// 5. Domain DTOs (what API routes return to the client)
// =========================================================

export type SessionStatus = "idle" | "recording" | "uploading" | "ready" | "error";

export interface SessionDTO {
  id: string;
  title: string;
  folderId: string | null;
  sourceLang: string;
  targetLang: string;
  status: SessionStatus;
  durationMs: number | null;
  audioPath: string | null;
  audioContentType: string | null;
  segmentCount: number;
  hasMinutes: boolean;
  audioUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SegmentDTO {
  id: string;
  sessionId: string;
  segmentIndex: number;
  audioStartMs: number;
  audioEndMs: number;
  speakerId: number | null;
  sourceText: string;
  translatedText: string | null;
  confidence: number | null;
  isFinal: boolean;
}

export interface SpeakerNameDTO {
  sessionId: string;
  speakerId: number;
  name: string;
}

export interface BookmarkDTO {
  id: string;
  sessionId: string;
  atMs: number;
  note: string | null;
  createdAt: string;
}

export interface MinutesSection {
  title: string;
  timeStartMs?: number;
  timeEndMs?: number;
  points: string[];
}
export interface MinutesDTO {
  id: string;
  sessionId: string;
  contentMd: string;
  sections: MinutesSection[] | null;
  model: string | null;
  status: "pending" | "streaming" | "done" | "error";
  createdAt: string;
  updatedAt: string;
}

export interface FolderDTO {
  id: string;
  name: string;
  color: string | null;
  sourceLang: string | null;
  targetLang: string | null;
  sessionCount: number;
  documentCount: number;
  createdAt: string;
}

export interface DocumentDTO {
  id: string;
  folderId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  blobUrl: string;
  extractionStatus: "pending" | "processing" | "done" | "failed";
  termCount: number;
  createdAt: string;
}

export interface ExtractedTermDTO {
  id: string;
  term: string;
  definition: string | null;
}

export interface FlashcardDTO {
  id: string;
  front: string;
  back: string;
  sourceSessionId: string | null;
  sourceSegmentId: string | null;
  intervalDays: number;
  easeFactor: number;
  reviewCount: number;
  nextReviewAt: string;
  createdAt: string;
}

export interface ChatSessionDTO {
  id: string;
  sessionId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatMessageDTO {
  id: string;
  chatSessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

// =========================================================
// 6. API request/response bodies (organized by route)
// =========================================================

// ---- Sessions ----
export interface CreateSessionBody {
  title?: string;
  folderId?: string | null;
  sourceLang: string;
  targetLang: string;
}
export interface UpdateSessionBody {
  title?: string;
  folderId?: string | null;
  status?: SessionStatus;
  durationMs?: number;
  audioPath?: string | null;
  audioContentType?: string | null;
}
export interface ListSessionsQuery {
  folderId?: string | "unfiled";
  status?: SessionStatus | "all";
  limit?: number;
  cursor?: string;
}

// ---- Segments ----
export interface CreateSegmentBody {
  segmentIndex: number;
  audioStartMs: number;
  audioEndMs: number;
  speakerId?: number;
  sourceText: string;
  translatedText?: string | null;
  confidence?: number;
  isFinal?: boolean;
}
export interface UpdateSegmentBody {
  sourceText?: string;
  translatedText?: string | null;
  speakerId?: number | null;
}
export interface BulkCreateSegmentsBody {
  segments: CreateSegmentBody[];
}

// ---- Speakers ----
export interface UpdateSpeakerNameBody {
  speakerId: number;
  name: string;
}

// ---- Audio upload ----
export interface ChunkPresignBody {
  sessionId: string;
  chunkIndex: number;
  contentType: string;
  sizeBytes: number;
}
export interface ChunkPresignResponse extends StoragePresignResponse {
  chunkId: string;
}
export interface ChunkRecordBody {
  sessionId: string;
  chunkIndex: number;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number;
  publicUrl: string;
  storageKey: string;
}
export interface FinalizeAudioBody {
  sessionId: string;
  totalDurationMs: number;
}
export interface FinalizeAudioResponse {
  sessionId: string;
  audioPath: string;
  audioContentType: string;
  durationMs: number;
  audioUrl: string;
}
export interface AudioStatusResponse {
  sessionId: string;
  uploadedChunks: number;
  totalBytes: number;
  state: "in_progress" | "finalized" | "error";
}

// ---- Soniox token ----
export type SonioxTokenBody = SonioxTokenRequest;
export type SonioxTokenResp = SonioxTokenResponse;

// ---- Translation ----
export type TranslateBody = TranslationRequest;
export type TranslateResp = TranslationResponse & { segmentId?: string };

// ---- Minutes ----
export interface GenerateMinutesBody {
  language?: string;
  styleHint?: string;
}
export type MinutesStreamEvent =
  | { type: "section_pending"; section: MinutesSection }
  | { type: "section_confirmed"; section: MinutesSection }
  | { type: "minutes_final"; contentMd: string }
  | { type: "error"; message: string };

// ---- Bookmarks ----
export interface CreateBookmarkBody {
  sessionId: string;
  atMs: number;
  note?: string;
}
export interface UpdateBookmarkBody {
  atMs?: number;
  note?: string | null;
}

// ---- Folders ----
export interface CreateFolderBody {
  name: string;
  color?: string;
  sourceLang?: string;
  targetLang?: string;
}
export interface UpdateFolderBody {
  name?: string;
  color?: string | null;
  sourceLang?: string | null;
  targetLang?: string | null;
}

// ---- Folder documents ----
export interface DocumentPresignBody {
  folderId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
}
export interface DocumentPresignResponse extends StoragePresignResponse {
  documentId: string;
  storageKey: string;
}
export interface DocumentConfirmBody {
  folderId: string;
  documentId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  blobUrl: string;
  storageKey: string;
}
export interface ExtractTermsResponse {
  documentId: string;
  status: DocumentDTO["extractionStatus"];
  terms: ExtractedTermDTO[];
}

// ---- Flashcards ----
export interface FlashcardRecommendBody {
  sourceSessionId: string;
  maxCards?: number;
}
export interface FlashcardRecommendResponse {
  candidates: Array<{ front: string; back: string; sourceSegmentId?: string }>;
}
export interface CreateFlashcardBody {
  front: string;
  back: string;
  sourceSessionId?: string;
  sourceSegmentId?: string;
}
export interface FlashcardReviewBody {
  /** SM-2 rating 0..5 */
  rating: 0 | 1 | 2 | 3 | 4 | 5;
}

// ---- Chat ----
export interface CreateChatSessionBody {
  sessionId?: string;
  title?: string;
}
export interface ChatRequestBody {
  /** chatSessionId is required for persistence */
  chatSessionId: string;
  /** Last user message (the route will load history from DB) */
  message: string;
  /** Override the model */
  model?: string;
}

// =========================================================
// 7. Recorder client-side types (browser only)
// =========================================================

export type RecorderState =
  | "idle"
  | "permission"
  | "connecting"
  | "connected"
  | "recording"
  | "paused"
  | "stopping"
  | "ended"
  | "error";

export type AudioSource = "microphone" | "system";
export type TranslationMode = "off" | "local" | "cloud";

export interface RecorderConfig {
  audioSource: AudioSource;
  sourceLanguage: string;
  targetLanguage: string;
  translationMode: TranslationMode;
  sessionId: string;
  /** Soniox temporary token from /api/soniox-token */
  sonioxToken: string;
  /** Custom vocabulary string sent to Soniox as `context` */
  transcriptionContext?: string;
  /** PCM sample rate sent to ASR (16000 for Soniox) */
  sampleRate?: number;
  /** Audio chunk upload interval in ms */
  uploadIntervalMs?: number;
  /** Speaker diarization on/off */
  enableSpeakerDiarization?: boolean;
  /** Soniox model id */
  sonioxModel?: string;
  /**
   * Optional live-share token. When set, the recorder fires utterance + segment
   * payloads to /api/live-share/{token}/push so remote viewers see the
   * transcript in real time. Fire-and-forget — failures do not block recording.
   */
  liveShareToken?: string;
}

export interface RecorderToken {
  /** Stable id while the token is non-final, becomes the segment id on finalization */
  id: string;
  text: string;
  isFinal: boolean;
  speakerId?: number;
  /** Translation token vs. source token */
  isTranslation?: boolean;
  /** ms since recording started */
  startMs: number;
  endMs: number;
}

/**
 * One sentence/utterance with paired source + translation text. The recorder
 * emits a stream of these — same `id` is reused while in-flight, and the
 * isFinal flag flips to true when Soniox signals the utterance boundary.
 */
export interface Utterance {
  id: string;
  speakerId?: number;
  startMs: number;
  endMs: number;
  sourceText: string;
  translatedText: string;
  isFinal: boolean;
}

export interface RecorderError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface RecorderEvent {
  state?: RecorderState;
  /** Sentence-level state update; the new primary stream from Soniox. */
  utterance?: Utterance;
  /** @deprecated use `utterance` — kept for backwards compat with older UI. */
  token?: RecorderToken;
  segment?: SegmentDTO;
  error?: RecorderError;
  /** 0..1 audio level for waveform meters */
  level?: number;
}

// =========================================================
// 8. Common helpers
// =========================================================

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  cursor?: string | null;
}

export const SUPPORTED_LANGUAGES = [
  "en", "zh", "ja", "es", "fr", "de", "ar", "hi", "pt", "ko",
  "ru", "it", "tr", "vi", "th", "nl", "pl", "sv", "id", "cs",
  "el", "hu", "ro", "uk",
] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  en: "English",
  zh: "中文",
  ja: "日本語",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  ar: "العربية",
  hi: "हिन्दी",
  pt: "Português",
  ko: "한국어",
  ru: "Русский",
  it: "Italiano",
  tr: "Türkçe",
  vi: "Tiếng Việt",
  th: "ภาษาไทย",
  nl: "Nederlands",
  pl: "Polski",
  sv: "Svenska",
  id: "Bahasa",
  cs: "Čeština",
  el: "Ελληνικά",
  hu: "Magyar",
  ro: "Română",
  uk: "Українська",
};
