/**
 * IndexedDB cache for audio chunks, mirroring lecsync's
 * AudioLocalCache (decompiled from /_next/static/chunks/
 * 53208ebe113570bb.js). Purpose: keep every captured chunk durable
 * locally BEFORE the network round-trip, so a tab close or browser
 * crash between "MediaRecorder produced chunk" and "PUT R2 finished"
 * doesn't lose audio.
 *
 * Schema: one object store `chunks`, keyPath `id = "{sessionId}-{chunkIndex}"`,
 * indexed by sessionId and by uploaded. Records:
 *
 *   {
 *     id:         string  // sessionId-chunkIndex
 *     sessionId:  string
 *     chunkIndex: number
 *     blob:       Blob    // the raw webm/opus bytes
 *     durationMs: number
 *     contentType: string // mime of the blob, e.g. "audio/webm;codecs=opus"
 *     createdAt:  number  // Date.now() at store time
 *     uploaded:   boolean // flipped true once /chunk-record returned OK
 *   }
 *
 * Lifecycle:
 *   1. Recorder produces chunk → storeChunk()
 *   2. Upload pipeline reads from cache → PUT to R2 → chunk-record
 *   3. On chunk-record success → markUploaded()
 *   4. Session finalized → clearSession() (or kept around briefly
 *      so a delayed cleanup pass collects it)
 *   5. Boot-time recovery → getAllPendingChunks() → retry uploads
 */

const DB_NAME = "voice-project-audio-cache";
const DB_VERSION = 1;
const STORE = "chunks";

export interface CachedChunk {
  id: string;
  sessionId: string;
  chunkIndex: number;
  blob: Blob;
  durationMs: number;
  contentType: string;
  createdAt: number;
  uploaded: boolean;
}

function isAvailable(): boolean {
  return typeof window !== "undefined" && "indexedDB" in window;
}

class AudioLocalCache {
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  private async openDatabase(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(new Error("Failed to open IndexedDB"));
      req.onsuccess = () => {
        this.db = req.result;
        resolve(req.result);
      };
      req.onupgradeneeded = (ev) => {
        const upgradeDb = (ev.target as IDBOpenDBRequest).result;
        if (!upgradeDb.objectStoreNames.contains(STORE)) {
          const store = upgradeDb.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("sessionId", "sessionId", { unique: false });
          store.createIndex("uploaded", "uploaded", { unique: false });
        }
      };
    });
    return this.dbPromise;
  }

  /** Persist a freshly-captured chunk. Idempotent on (sessionId, chunkIndex). */
  async storeChunk(
    sessionId: string,
    chunkIndex: number,
    blob: Blob,
    durationMs: number,
    contentType: string
  ): Promise<void> {
    if (!isAvailable()) return;
    const db = await this.openDatabase();
    const record: CachedChunk = {
      id: `${sessionId}-${chunkIndex}`,
      sessionId,
      chunkIndex,
      blob,
      durationMs,
      contentType,
      createdAt: Date.now(),
      uploaded: false,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const req = tx.objectStore(STORE).put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error("Failed to store chunk"));
    });
  }

  /** Flag a chunk as successfully uploaded. No-op if the row is gone. */
  async markUploaded(sessionId: string, chunkIndex: number): Promise<void> {
    if (!isAvailable()) return;
    const db = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const getReq = store.get(`${sessionId}-${chunkIndex}`);
      getReq.onsuccess = () => {
        const row = getReq.result as CachedChunk | undefined;
        if (!row) return resolve(); // already cleared, fine
        row.uploaded = true;
        const putReq = store.put(row);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(new Error("Failed to mark uploaded"));
      };
      getReq.onerror = () => reject(new Error("Failed to read chunk row"));
    });
  }

  /** All not-yet-uploaded chunks for one session, oldest chunkIndex first. */
  async getPendingChunks(sessionId: string): Promise<CachedChunk[]> {
    if (!isAvailable()) return [];
    const db = await this.openDatabase();
    return new Promise<CachedChunk[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const idx = tx.objectStore(STORE).index("sessionId");
      const req = idx.getAll(sessionId);
      req.onsuccess = () => {
        const rows = (req.result as CachedChunk[])
          .filter((r) => !r.uploaded)
          .sort((a, b) => a.chunkIndex - b.chunkIndex);
        resolve(rows);
      };
      req.onerror = () => reject(new Error("Failed to query pending chunks"));
    });
  }

  /** All not-yet-uploaded chunks across every session, oldest first. */
  async getAllPendingChunks(): Promise<CachedChunk[]> {
    if (!isAvailable()) return [];
    const db = await this.openDatabase();
    return new Promise<CachedChunk[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const rows = (req.result as CachedChunk[])
          .filter((r) => !r.uploaded)
          .sort((a, b) => a.createdAt - b.createdAt);
        resolve(rows);
      };
      req.onerror = () => reject(new Error("Failed to query all pending"));
    });
  }

  /** Drop every chunk row for one session — call after the session is
   *  finalized + the user has been shown the result. */
  async clearSession(sessionId: string): Promise<void> {
    if (!isAvailable()) return;
    const db = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const idx = store.index("sessionId");
      const getReq = idx.getAll(sessionId);
      getReq.onsuccess = () => {
        const rows = getReq.result as CachedChunk[];
        let remaining = rows.length;
        if (remaining === 0) return resolve();
        for (const r of rows) {
          const del = store.delete(r.id);
          del.onsuccess = () => {
            if (--remaining === 0) resolve();
          };
          del.onerror = () => reject(new Error("Failed to delete chunk"));
        }
      };
      getReq.onerror = () => reject(new Error("Failed to enumerate session"));
    });
  }

  /** Garbage-collect already-uploaded rows older than maxAgeMs.
   *  Default 24h matches lecsync's value — keeps recently-uploaded
   *  chunks around briefly so a "I just finished, did it work?" recovery
   *  pass still finds them. */
  async cleanupOldChunks(maxAgeMs = 86_400_000): Promise<number> {
    if (!isAvailable()) return 0;
    const db = await this.openDatabase();
    const cutoff = Date.now() - maxAgeMs;
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result as CachedChunk[]).filter(
          (r) => r.uploaded && r.createdAt < cutoff
        );
        let remaining = rows.length;
        if (remaining === 0) return resolve(0);
        for (const r of rows) {
          const del = store.delete(r.id);
          del.onsuccess = () => {
            if (--remaining === 0) resolve(rows.length);
          };
          del.onerror = () => reject(new Error("Failed to delete old chunk"));
        }
      };
      req.onerror = () => reject(new Error("Failed to scan store"));
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.dbPromise = null;
  }
}

let singleton: AudioLocalCache | null = null;
export function getAudioLocalCache(): AudioLocalCache {
  if (!singleton) singleton = new AudioLocalCache();
  return singleton;
}

export type { AudioLocalCache };
