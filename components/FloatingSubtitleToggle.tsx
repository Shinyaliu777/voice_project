"use client";

import * as React from "react";
import * as ReactDOM from "react-dom";
import { PictureInPicture2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FloatingSubtitleWindow } from "@/components/FloatingSubtitleWindow";

// ----------------------------------------------------------------------
// Document Picture-in-Picture global shim
// ----------------------------------------------------------------------

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

function getDocumentPiP(): DocumentPiPController | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    documentPictureInPicture?: DocumentPiPController;
  };
  return w.documentPictureInPicture ?? null;
}

// ----------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------

export interface FloatingSubtitleToggleProps {
  /** Current latest non-translation source text (concatenated tail of tokens). */
  latestSourceText: string;
  /** Current latest translation text. */
  latestTranslatedText: string;
  /** Whether the recorder is actively producing tokens. */
  recording: boolean;
  /** Whether translation column has anything to show. */
  showTranslation: boolean;
  /**
   * External signal to force-close the PiP window (e.g., when the recorder
   * transitions out of `recording`).
   */
  closeSignal?: number;
  className?: string;
}

export function FloatingSubtitleToggle({
  latestSourceText,
  latestTranslatedText,
  recording,
  showTranslation,
  closeSignal,
  className,
}: FloatingSubtitleToggleProps) {
  const [pipDoc, setPipDoc] = React.useState<Document | null>(null);
  const [container, setContainer] = React.useState<HTMLDivElement | null>(null);
  const pipWindowRef = React.useRef<DocumentPiPWindow | null>(null);
  const [opening, setOpening] = React.useState(false);

  const closePip = React.useCallback(() => {
    try {
      pipWindowRef.current?.close();
    } catch {
      /* ignore */
    }
    pipWindowRef.current = null;
    setPipDoc(null);
    setContainer(null);
  }, []);

  // Respond to parent's close signal (e.g., when recording stops).
  React.useEffect(() => {
    if (closeSignal === undefined) return;
    if (pipWindowRef.current) closePip();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeSignal]);

  // Cleanup on unmount.
  React.useEffect(() => {
    return () => {
      closePip();
    };
  }, [closePip]);

  const openPip = React.useCallback(async () => {
    const ctrl = getDocumentPiP();
    if (!ctrl) {
      toast.error("需要 Chrome 116+ 的 Document Picture-in-Picture");
      return;
    }
    setOpening(true);
    try {
      const w = await ctrl.requestWindow({ width: 480, height: 200 });
      pipWindowRef.current = w;

      const root = w.document.createElement("div");
      root.id = "floating-subtitle-root";
      root.style.width = "100%";
      root.style.height = "100%";
      w.document.body.style.margin = "0";
      w.document.body.style.padding = "0";
      w.document.body.style.background = "transparent";
      w.document.body.appendChild(root);

      // Mark the html/body so flexbox host stretches full window.
      w.document.documentElement.style.height = "100%";
      w.document.body.style.height = "100%";

      // The PiP window emits `pagehide` when the user closes it.
      const onClose = () => {
        pipWindowRef.current = null;
        setPipDoc(null);
        setContainer(null);
      };
      w.addEventListener("pagehide", onClose, { once: true });

      setPipDoc(w.document);
      setContainer(root);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "无法打开悬浮字幕窗口";
      toast.error(message);
    } finally {
      setOpening(false);
    }
  }, []);

  const handleToggle = React.useCallback(() => {
    if (pipWindowRef.current) {
      closePip();
    } else {
      void openPip();
    }
  }, [closePip, openPip]);

  const open = pipDoc !== null && container !== null;

  return (
    <>
      <Button
        type="button"
        variant={open ? "secondary" : "outline"}
        size="sm"
        onClick={handleToggle}
        disabled={opening}
        className={className}
      >
        {open ? <X className="h-4 w-4" /> : <PictureInPicture2 className="h-4 w-4" />}
        <span>{open ? "关闭悬浮字幕" : "悬浮字幕"}</span>
      </Button>

      {open && container
        ? ReactDOM.createPortal(
            <FloatingSubtitleWindow
              latestSourceText={latestSourceText}
              latestTranslatedText={latestTranslatedText}
              showTranslation={showTranslation}
              recording={recording}
            />,
            container
          )
        : null}
    </>
  );
}

export default FloatingSubtitleToggle;
