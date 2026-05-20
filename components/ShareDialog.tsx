"use client";

import * as React from "react";
import {
  Copy,
  ExternalLink,
  Link as LinkIcon,
  Loader2,
  Mail,
  Share2,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export interface ShareDialogProps {
  sessionId: string;
  /** Controlled open state. Omit (with onOpenChange) to use built-in trigger button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Recording title — shown in the dialog header for context. */
  title?: string;
  /** Label of the auto-rendered trigger button when uncontrolled. */
  triggerLabel?: string;
}

/**
 * Session-level share dialog used on the history detail page.
 *
 * The "链接分享" tab mints a real live-share token via `/api/live-share`
 * — the same path Recorder.tsx uses to share an ongoing session. For a
 * finished recording the viewer's SSE feed emits the `joined` event
 * with every persisted segment, then stays quiet (no live events) — so
 * the viewer ends up showing a read-only full-transcript page.
 *
 * The "邮箱分享" tab is intentionally left disabled until the email
 * pipeline lands — the previous implementation POSTed to a 404
 * `/api/share/email` endpoint and just silently dropped the user.
 * Honesty > a broken submit button.
 */
export function ShareDialog({
  sessionId,
  open: openProp,
  onOpenChange,
  title,
  triggerLabel,
}: ShareDialogProps) {
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

  const [link, setLink] = React.useState<string | null>(null);
  const [minting, setMinting] = React.useState(false);

  // Reset the minted link when the dialog closes so each open mints a
  // fresh token. Avoids leaking a stale token from a previous open
  // after the user revoked it elsewhere.
  React.useEffect(() => {
    if (!open) {
      setLink(null);
      setMinting(false);
    }
  }, [open]);

  const generateLink = async () => {
    if (minting) return;
    setMinting(true);
    try {
      const resp = await fetch("/api/live-share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!resp.ok) {
        const detail = (await resp.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(detail?.error ?? `生成链接失败 (${resp.status})`);
        return;
      }
      const data = (await resp.json()) as { url?: string };
      if (!data.url) {
        toast.error("生成链接失败 — 响应中无 url");
        return;
      }
      setLink(data.url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "生成链接失败");
    } finally {
      setMinting(false);
    }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("链接已复制");
    } catch {
      toast.error("复制失败");
    }
  };

  const headerSubtitle = title
    ? `${title} · 生成只读链接，对方无需登录即可查看`
    : "生成只读链接，对方无需登录即可查看";

  return (
    <>
      {!isControlled && (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Share2 className="h-4 w-4" />
          <span>{triggerLabel ?? "分享"}</span>
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>分享会议</DialogTitle>
            <DialogDescription>{headerSubtitle}</DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="link" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="link">
                <LinkIcon className="mr-1.5 h-4 w-4" />
                链接分享
              </TabsTrigger>
              <TabsTrigger value="email">
                <Mail className="mr-1.5 h-4 w-4" />
                邮箱分享
              </TabsTrigger>
            </TabsList>

            <TabsContent value="link" className="flex flex-col gap-3 pt-2">
              {link ? (
                <>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={link}
                      className="font-mono text-xs"
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={copyLink}
                      aria-label="复制链接"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    任何拥有此链接的人都可以查看转录与翻译。需要撤销时，
                    在「实时分享」对话框里重新生成会获得一个新 token。
                  </p>
                </>
              ) : (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  生成只读链接，发送给同学或同事 — 无需登录即可查看完整转录。
                </p>
              )}
              <DialogFooter className="flex-wrap gap-2">
                {link ? (
                  <>
                    <a
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:hover:bg-zinc-900"
                    >
                      <ExternalLink className="h-4 w-4" />
                      <span>新标签页打开</span>
                    </a>
                    <Button onClick={generateLink} disabled={minting}>
                      {minting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <LinkIcon className="h-4 w-4" />
                      )}
                      <span>重新生成</span>
                    </Button>
                  </>
                ) : (
                  <Button onClick={generateLink} disabled={minting}>
                    {minting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <LinkIcon className="h-4 w-4" />
                    )}
                    <span>生成链接</span>
                  </Button>
                )}
              </DialogFooter>
            </TabsContent>

            {/* Email path is intentionally a placeholder — there's no
                /api/share/email endpoint yet. Leaving the inputs
                disabled so users see "what this will do" without
                hitting a 404 on submit. */}
            <TabsContent value="email" className="flex flex-col gap-3 pt-2">
              <div className="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                邮箱分享即将推出 · 当前请使用链接分享发送给对方
              </div>
              <Input
                type="email"
                placeholder="name@example.com"
                disabled
                aria-label="邮箱"
              />
              <DialogFooter>
                <Button disabled>
                  <Mail className="h-4 w-4" />
                  <span>发送邀请（即将推出）</span>
                </Button>
              </DialogFooter>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default ShareDialog;
