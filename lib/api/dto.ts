/**
 * DTO helpers: convert Prisma rows -> client-facing DTO shapes from contracts.ts.
 *
 * Conventions:
 *  - Dates -> ISO strings.
 *  - JSON fields -> typed where the contract pins a shape.
 *  - Optional counts (segmentCount, hasMinutes, audioUrl, etc.) come from the
 *    caller as a small `counts` object. Callers should pass what they need;
 *    sensible defaults are applied when omitted so handlers can be terse.
 */

import type {
  Bookmark,
  ChatMessage,
  ChatSession,
  Document,
  ExtractedTerm,
  Flashcard,
  Folder,
  Minutes,
  Segment,
  Session,
  SpeakerName,
} from "@prisma/client";

import type {
  BookmarkDTO,
  ChatMessageDTO,
  ChatSessionDTO,
  DocumentDTO,
  ExtractedTermDTO,
  FlashcardDTO,
  FolderDTO,
  MinutesDTO,
  MinutesSection,
  SegmentDTO,
  SessionDTO,
  SessionStatus,
  SpeakerNameDTO,
} from "@/lib/contracts";

// ---------- internal helpers ----------

function iso(d: Date | string | null | undefined): string {
  if (!d) return new Date(0).toISOString();
  return typeof d === "string" ? d : d.toISOString();
}

function isoOrNow(d: Date | string | null | undefined): string {
  return d ? iso(d) : new Date().toISOString();
}

const VALID_SESSION_STATUSES: SessionStatus[] = [
  "idle",
  "recording",
  "uploading",
  "ready",
  "error",
];

function coerceSessionStatus(s: string): SessionStatus {
  return (VALID_SESSION_STATUSES as string[]).includes(s)
    ? (s as SessionStatus)
    : "idle";
}

const VALID_MINUTES_STATUSES: MinutesDTO["status"][] = [
  "pending",
  "streaming",
  "done",
  "error",
];

function coerceMinutesStatus(s: string): MinutesDTO["status"] {
  return (VALID_MINUTES_STATUSES as string[]).includes(s)
    ? (s as MinutesDTO["status"])
    : "pending";
}

const VALID_DOCUMENT_STATUSES: DocumentDTO["extractionStatus"][] = [
  "pending",
  "processing",
  "done",
  "failed",
];

function coerceDocumentStatus(s: string): DocumentDTO["extractionStatus"] {
  return (VALID_DOCUMENT_STATUSES as string[]).includes(s)
    ? (s as DocumentDTO["extractionStatus"])
    : "pending";
}

const VALID_CHAT_ROLES: ChatMessageDTO["role"][] = ["user", "assistant", "system"];

function coerceChatRole(r: string): ChatMessageDTO["role"] {
  return (VALID_CHAT_ROLES as string[]).includes(r)
    ? (r as ChatMessageDTO["role"])
    : "user";
}

// ---------- Session ----------

export interface SessionDTOCounts {
  segmentCount?: number;
  hasMinutes?: boolean;
  audioUrl?: string | null;
}

export function toSessionDTO(
  row: Session,
  counts: SessionDTOCounts = {}
): SessionDTO {
  return {
    id: row.id,
    title: row.title ?? "",
    folderId: row.folderId ?? null,
    sourceLang: row.sourceLang,
    targetLang: row.targetLang,
    status: coerceSessionStatus(row.status),
    durationMs: row.durationMs ?? null,
    audioPath: row.audioPath ?? null,
    audioContentType: row.audioContentType ?? null,
    segmentCount: counts.segmentCount ?? 0,
    hasMinutes: counts.hasMinutes ?? false,
    audioUrl: counts.audioUrl ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

// ---------- Segment ----------

export function toSegmentDTO(row: Segment): SegmentDTO {
  return {
    id: row.id,
    sessionId: row.sessionId,
    segmentIndex: row.segmentIndex,
    audioStartMs: row.audioStartMs,
    audioEndMs: row.audioEndMs,
    speakerId: row.speakerId ?? null,
    sourceText: row.sourceText,
    translatedText: row.translatedText ?? null,
    confidence: row.confidence ?? null,
    isFinal: row.isFinal,
  };
}

// ---------- Folder ----------

export interface FolderDTOCounts {
  sessionCount?: number;
  documentCount?: number;
}

export function toFolderDTO(
  row: Folder,
  counts: FolderDTOCounts = {}
): FolderDTO {
  return {
    id: row.id,
    name: row.name,
    color: row.color ?? null,
    sourceLang: row.sourceLang ?? null,
    targetLang: row.targetLang ?? null,
    sessionCount: counts.sessionCount ?? 0,
    documentCount: counts.documentCount ?? 0,
    createdAt: iso(row.createdAt),
  };
}

// ---------- Bookmark ----------

export function toBookmarkDTO(row: Bookmark): BookmarkDTO {
  return {
    id: row.id,
    sessionId: row.sessionId,
    atMs: row.atMs,
    note: row.note ?? null,
    createdAt: iso(row.createdAt),
  };
}

// ---------- SpeakerName ----------

export function toSpeakerNameDTO(row: SpeakerName): SpeakerNameDTO {
  return {
    sessionId: row.sessionId,
    speakerId: row.speakerId,
    name: row.name,
  };
}

// ---------- Minutes ----------

function parseMinutesSections(value: unknown): MinutesSection[] | null {
  if (!value) return null;
  if (!Array.isArray(value)) return null;
  // Trust the writer (route handler) to have stored MinutesSection-shaped objects.
  // We only filter to ensure the basic invariants hold.
  const out: MinutesSection[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.title !== "string") continue;
    const points = Array.isArray(obj.points)
      ? obj.points.filter((p): p is string => typeof p === "string")
      : [];
    const section: MinutesSection = { title: obj.title, points };
    if (typeof obj.timeStartMs === "number") section.timeStartMs = obj.timeStartMs;
    if (typeof obj.timeEndMs === "number") section.timeEndMs = obj.timeEndMs;
    out.push(section);
  }
  return out;
}

export function toMinutesDTO(row: Minutes): MinutesDTO {
  return {
    id: row.id,
    sessionId: row.sessionId,
    contentMd: row.contentMd ?? "",
    sections: parseMinutesSections(row.sectionsJson),
    model: row.model ?? null,
    status: coerceMinutesStatus(row.status),
    liveContentMd: row.liveContentMd ?? "",
    liveSections: parseMinutesSections(row.liveSectionsJson),
    liveModel: row.liveModel ?? null,
    liveStatus: coerceMinutesStatus(row.liveStatus),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

// ---------- Flashcard ----------

export function toFlashcardDTO(row: Flashcard): FlashcardDTO {
  return {
    id: row.id,
    front: row.front,
    back: row.back,
    sourceSessionId: row.sourceSessionId ?? null,
    sourceSegmentId: row.sourceSegmentId ?? null,
    intervalDays: row.intervalDays,
    easeFactor: row.easeFactor,
    reviewCount: row.reviewCount,
    nextReviewAt: iso(row.nextReviewAt),
    createdAt: iso(row.createdAt),
  };
}

// ---------- ChatSession / ChatMessage ----------

export interface ChatSessionDTOCounts {
  messageCount?: number;
}

export function toChatSessionDTO(
  row: ChatSession,
  counts: ChatSessionDTOCounts = {}
): ChatSessionDTO {
  return {
    id: row.id,
    sessionId: row.sessionId ?? null,
    title: row.title ?? "Untitled",
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    messageCount: counts.messageCount ?? 0,
  };
}

export function toChatMessageDTO(row: ChatMessage): ChatMessageDTO {
  return {
    id: row.id,
    chatSessionId: row.chatSessionId,
    role: coerceChatRole(row.role),
    content: row.content,
    createdAt: iso(row.createdAt),
  };
}

// ---------- Document / ExtractedTerm ----------

export interface DocumentDTOCounts {
  termCount?: number;
}

export function toDocumentDTO(
  row: Document,
  counts: DocumentDTOCounts = {}
): DocumentDTO {
  return {
    id: row.id,
    folderId: row.folderId,
    fileName: row.fileName,
    fileType: row.fileType,
    fileSize: row.fileSize,
    blobUrl: row.blobUrl,
    extractionStatus: coerceDocumentStatus(row.extractionStatus),
    termCount: counts.termCount ?? 0,
    createdAt: iso(row.createdAt),
  };
}

export function toExtractedTermDTO(row: ExtractedTerm): ExtractedTermDTO {
  return {
    id: row.id,
    term: row.term,
    definition: row.definition ?? null,
  };
}

// Re-export the small util in case agents want it elsewhere.
export const _internal = { iso, isoOrNow };
