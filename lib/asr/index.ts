/**
 * ASR provider factory.
 *
 * Today there's only Soniox, but the indirection keeps API routes
 * decoupled so a future provider can be swapped in without touching them.
 */
import type { ASRProvider } from "../contracts";
import { SonioxProvider } from "./soniox";

let cached: ASRProvider | null = null;

export function getASRProvider(): ASRProvider {
  if (!cached) {
    cached = new SonioxProvider();
  }
  return cached;
}
