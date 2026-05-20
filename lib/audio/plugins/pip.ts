/**
 * PipPlugin — Picture-in-Picture floating subtitle window.
 *
 * Owns the lifecycle of a Document Picture-in-Picture window that mirrors
 * the live transcript. Behaviour copied from the existing
 * `components/FloatingSubtitleToggle.tsx` — the React component currently
 * tracks the PiP window in local state. After the migration the component
 * becomes a thin wrapper that calls `plugin.open() / plugin.close()` and
 * renders into the container the plugin exposes.
 *
 * The plugin does NOT mount React itself — React knows how to portal
 * into the plugin's container, so the host stays in the React tree.
 * The plugin only owns:
 *   - capability detection (Document PiP exists)
 *   - window lifecycle (open / close / pagehide listener)
 *   - the root `<div>` inside the PiP doc that the portal targets
 *   - user-settings driven width/height/fontScale
 *
 * Subscribers (the React component) call `subscribe()` to receive
 * `{ open, container, fontScale }` snapshots as the window opens/closes.
 */

import type { TranscriptionService } from "@/lib/audio/transcription-service";

interface DocumentPiPRequestOptions {
  width?: number;
  height?: number;
}
interface DocumentPiPWindow extends Window {
  document: Document;
}
interface DocumentPiPController {
  requestWindow(opts?: DocumentPiPRequestOptions): Promise<DocumentPiPWindow>;
  window?: DocumentPiPWindow | null;
}

export interface PipState {
  /** True while a PiP window is open. */
  open: boolean;
  /** The root element React should portal into. Null while closed. */
  container: HTMLDivElement | null;
  /** Scaled font multiplier (1.0 = default). */
  fontScale: number;
  /** Whether this browser supports Document PiP at all. */
  supported: boolean;
}

export type PipSubscriber = (state: PipState) => void;

export class PipPlugin {
  private service: TranscriptionService | null = null;
  private subscribers = new Set<PipSubscriber>();
  private pipWindow: DocumentPiPWindow | null = null;
  private state: PipState = {
    open: false,
    container: null,
    fontScale: 1,
    supported: false,
  };

  // Defaults — settings hydration overrides these when init runs.
  private windowWidth = 480;
  private windowHeight = 200;
  /** Source-text baseline px the FloatingSubtitleWindow renders at. */
  private static readonly SOURCE_BASE_PX = 22;

  init(service: TranscriptionService): void {
    this.service = service;
    this.state = {
      ...this.state,
      supported: getDocumentPiP() !== null,
    };
    void this.hydrateUserSettings();
    this.notify();
  }

  destroy(): void {
    this.close();
    this.subscribers.clear();
    this.service = null;
  }

  getState(): PipState {
    return this.state;
  }

  subscribe(handler: PipSubscriber): () => void {
    this.subscribers.add(handler);
    handler(this.state);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  async open(): Promise<void> {
    const ctrl = getDocumentPiP();
    if (!ctrl) throw new Error("需要 Chrome 116+ 的 Document Picture-in-Picture");
    if (this.pipWindow) return; // already open

    const w = await ctrl.requestWindow({
      width: this.windowWidth,
      height: this.windowHeight,
    });
    this.pipWindow = w;

    const root = w.document.createElement("div");
    root.id = "floating-subtitle-root";
    root.style.width = "100%";
    root.style.height = "100%";
    w.document.body.style.margin = "0";
    w.document.body.style.padding = "0";
    w.document.body.style.background = "transparent";
    w.document.body.appendChild(root);
    w.document.documentElement.style.height = "100%";
    w.document.body.style.height = "100%";

    const onClose = () => {
      this.pipWindow = null;
      this.state = { ...this.state, open: false, container: null };
      this.notify();
    };
    w.addEventListener("pagehide", onClose, { once: true });

    this.state = { ...this.state, open: true, container: root };
    this.notify();
  }

  close(): void {
    if (this.pipWindow) {
      try { this.pipWindow.close(); } catch { /* ignore */ }
    }
    this.pipWindow = null;
    if (this.state.open || this.state.container) {
      this.state = { ...this.state, open: false, container: null };
      this.notify();
    }
  }

  toggle(): Promise<void> | void {
    if (this.state.open) {
      this.close();
      return;
    }
    return this.open();
  }

  private async hydrateUserSettings(): Promise<void> {
    try {
      const resp = await fetch("/api/user/settings");
      if (!resp.ok) return;
      const data = (await resp.json()) as { settings?: Record<string, unknown> };
      const s = data.settings ?? {};
      const w = Number(s.floatingWindowWidth);
      const h = Number(s.floatingWindowHeight);
      const f = Number(s.floatingFontSize);
      if (Number.isFinite(w) && w > 240 && w < 1200) this.windowWidth = w;
      if (Number.isFinite(h) && h > 120 && h < 800) this.windowHeight = h;
      if (Number.isFinite(f) && f > 8 && f < 48) {
        this.state = {
          ...this.state,
          fontScale: f / PipPlugin.SOURCE_BASE_PX,
        };
        this.notify();
      }
    } catch {
      /* keep defaults */
    }
  }

  private notify(): void {
    for (const cb of this.subscribers) {
      try { cb(this.state); } catch { /* swallow */ }
    }
  }
}

function getDocumentPiP(): DocumentPiPController | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    documentPictureInPicture?: DocumentPiPController;
  };
  return w.documentPictureInPicture ?? null;
}
