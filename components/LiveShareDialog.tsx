"use client";

import * as React from "react";
import { Copy, ExternalLink, Loader2, Radio, Share2 } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export interface LiveShareDialogProps {
  sessionId: string;
  /** Controlled open state. Omit (with onOpenChange) to use the built-in trigger button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Called once the server returns a viewer URL. */
  onTokenMinted?: (info: { token: string; url: string }) => void;
}

interface LiveShareState {
  loading: boolean;
  token: string | null;
  viewerUrl: string | null;
  error: string | null;
}

const initialState: LiveShareState = {
  loading: false,
  token: null,
  viewerUrl: null,
  error: null,
};

/**
 * Mints a public live-share URL for an ongoing recording session.
 *
 * The recording client is expected to read `viewerUrl`'s token (or use
 * `onTokenMinted`) and forward utterances to /api/live-share/{token}/push.
 */
export function LiveShareDialog({
  sessionId,
  open: openProp,
  onOpenChange,
  onTokenMinted,
}: LiveShareDialogProps) {
  const isControlled = openProp !== undefined;
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = isControlled ? !!openProp : internalOpen;
  const setOpen = React.useCallback(
    (v: boolean) => {
      if (isControlled) onOpenChange?.(v);
      else setInternalOpen(v);
    },
    [isControlled, onOpenChange]
  );

  const [state, setState] = React.useState<LiveShareState>(initialState);

  // Auto-mint on open (only once per open).
  const mintedForOpenRef = React.useRef(false);
  React.useEffect(() => {
    if (!open) {
      mintedForOpenRef.current = false;
      return;
    }
    if (mintedForOpenRef.current || state.viewerUrl || state.loading) return;
    mintedForOpenRef.current = true;

    let cancelled = false;
    (async () => {
      setState({ ...initialState, loading: true });
      try {
        const resp = await fetch("/api/live-share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        if (!resp.ok) {
          throw new Error(`mint failed (${resp.status})`);
        }
        const data = (await resp.json()) as { token: string; url: string };
        if (cancelled) return;
        setState({
          loading: false,
          token: data.token,
          viewerUrl: data.url,
          error: null,
        });
        onTokenMinted?.({ token: data.token, url: data.url });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "无法生成分享链接";
        setState({ loading: false, token: null, viewerUrl: null, error: message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, state.viewerUrl, state.loading, onTokenMinted]);

  const copy = async () => {
    if (!state.viewerUrl) return;
    try {
      await navigator.clipboard.writeText(state.viewerUrl);
      toast.success("链接已复制");
    } catch {
      toast.error("复制失败");
    }
  };

  return (
    <>
      {!isControlled && (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Share2 className="h-4 w-4" />
          <span>实时分享</span>
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-rose-500" />
              <span>实时分享</span>
            </DialogTitle>
            <DialogDescription>
              生成一个公开链接，观众无需登录即可实时查看本次录制的字幕。
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            {state.loading ? (
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>正在生成链接…</span>
              </div>
            ) : state.error ? (
              <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
                {state.error}
              </p>
            ) : state.viewerUrl ? (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={state.viewerUrl}
                    className="font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={copy}
                    aria-label="复制链接"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  任何拥有此链接的人都可以查看实时字幕。结束录制后链接将不再更新。
                </p>
              </>
            ) : null}
          </div>

          <DialogFooter>
            {state.viewerUrl ? (
              <a
                href={state.viewerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:hover:bg-zinc-900"
              >
                <ExternalLink className="h-4 w-4" />
                <span>新标签页打开</span>
              </a>
            ) : null}
            <Button variant="outline" onClick={() => setOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default LiveShareDialog;
