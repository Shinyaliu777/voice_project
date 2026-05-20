/**
 * Single source of truth for translating a stored audio path into a
 * URL the browser can fetch / seek / range-read.
 *
 * All callers should funnel through here instead of inlining the
 * `/api/audio/file/${path}` template — six call sites used to do
 * that, plus the detail page was using storage.publicUrlFor() which
 * gives the raw storage URL (works only for local-fs, not S3). The
 * streaming route is the portable answer because it:
 *   - hides the storage provider (local fs vs R2 vs S3) behind one URL
 *   - honors HTTP Range headers so the <audio> element can seek
 *   - lets us add auth in the future without changing call sites
 */

/**
 * @param audioPath storage key, e.g. "audio/<sessionId>/final.webm".
 *   Pass null/undefined for sessions that haven't finalized yet.
 * @returns absolute (in the Next.js sense) URL, or null if no path.
 */
export function audioFileUrl(
  audioPath: string | null | undefined
): string | null {
  if (!audioPath) return null;
  // Path segments may contain characters that need encoding (cuids
  // don't, but file extensions and any future tenant-prefixed keys
  // might). encodeURI keeps the slashes; encodeURIComponent would
  // mangle them.
  return `/api/audio/file/${encodeURI(audioPath)}`;
}
