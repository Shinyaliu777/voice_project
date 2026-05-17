"use client";

import * as React from "react";
import { AlertTriangle, Check, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ChromeTranslator {
  availability(opts: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<string>;
  create(opts: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: EventTarget) => void;
  }): Promise<{ translate(text: string): Promise<string> }>;
}

type State =
  | "checking"
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable"
  | "error";

export interface LocalTranslatorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceLanguage: string;
  targetLanguage: string;
  /** Called once the language pair is confirmed ready for translation. */
  onReady?: () => void;
  /** Called when user dismisses the dialog without completing setup. */
  onCancel?: () => void;
}

function readTranslator(): ChromeTranslator | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { Translator?: ChromeTranslator };
  return w.Translator ?? null;
}

export function LocalTranslatorDialog({
  open,
  onOpenChange,
  sourceLanguage,
  targetLanguage,
  onReady,
  onCancel,
}: LocalTranslatorDialogProps) {
  const [state, setState] = React.useState<State>("checking");
  const [progress, setProgress] = React.useState(0);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const completedRef = React.useRef(false);

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    completedRef.current = false;
    setProgress(0);
    setErrorMsg(null);
    setState("checking");

    (async () => {
      const T = readTranslator();
      if (!T) {
        if (alive) setState("unavailable");
        return;
      }
      try {
        const a = await T.availability({ sourceLanguage, targetLanguage });
        if (!alive) return;
        if (a === "available") {
          setState("available");
          completedRef.current = true;
          onReady?.();
        } else if (a === "downloadable" || a === "downloading") {
          setState(a as State);
        } else {
          setState("unavailable");
        }
      } catch (err) {
        if (!alive) return;
        setErrorMsg(err instanceof Error ? err.message : "无法查询可用性");
        setState("error");
      }
    })();

    return () => {
      alive = false;
    };
  }, [open, sourceLanguage, targetLanguage, onReady]);

  const downloadModel = async () => {
    const T = readTranslator();
    if (!T) {
      setState("unavailable");
      return;
    }
    setState("downloading");
    setProgress(0);
    setErrorMsg(null);
    try {
      const translator = await T.create({
        sourceLanguage,
        targetLanguage,
        monitor(m) {
          m.addEventListener("downloadprogress", (e: Event) => {
            const evt = e as Event & { loaded?: number };
            if (typeof evt.loaded === "number") setProgress(evt.loaded);
          });
        },
      });
      // Smoke test — also forces the runtime to finalize warmup.
      await translator.translate("hello");
      setState("available");
      completedRef.current = true;
      toast.success("本地翻译模型已就绪");
      onReady?.();
      // Auto-close shortly so the user sees the success state.
      setTimeout(() => onOpenChange(false), 700);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "下载失败");
      setState("error");
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && !completedRef.current) onCancel?.();
    onOpenChange(next);
  };

  const pair = `${sourceLanguage.toUpperCase()} → ${targetLanguage.toUpperCase()}`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>启用本地翻译</DialogTitle>
          <DialogDescription>
            {pair} · 基于 Chrome 原生 Translator API，模型下载后可离线使用
          </DialogDescription>
        </DialogHeader>

        <div className="py-2 text-sm">
          {state === "checking" && (
            <div className="flex items-center gap-2 text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>正在检查可用性…</span>
            </div>
          )}

          {state === "available" && (
            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
              <Check className="h-4 w-4" />
              <span>模型已就绪，可以开始录制</span>
            </div>
          )}

          {state === "downloadable" && (
            <p className="text-zinc-600 dark:text-zinc-300">
              语言模型还没下载（大约 50MB）。下载一次后会离线缓存，之后切换语种瞬间生效。
            </p>
          )}

          {state === "downloading" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-zinc-700 dark:text-zinc-200">
                <span>正在下载模型…</span>
                <span className="font-mono tabular-nums">
                  {Math.round(progress * 100)}%
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div
                  className="h-full rounded-full bg-zinc-900 transition-all duration-200 dark:bg-zinc-100"
                  style={{ width: `${Math.max(2, Math.round(progress * 100))}%` }}
                />
              </div>
            </div>
          )}

          {state === "unavailable" && (
            <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">这台浏览器上的 Translator API 不可用</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  需要 Chrome 138+ 并在{" "}
                  <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
                    chrome://flags/#translation-api
                  </code>{" "}
                  开启「Translation API」flag，重启 Chrome 后重试。也可以直接改用「云端」档（用 Soniox 内置翻译）。
                </p>
              </div>
            </div>
          )}

          {state === "error" && (
            <div className="flex items-start gap-2 text-rose-700 dark:text-rose-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{errorMsg ?? "出错了，重试或改用云端档"}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {state === "downloadable" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                改用云端
              </Button>
              <Button onClick={downloadModel}>
                <Download className="h-4 w-4" />
                <span>下载模型</span>
              </Button>
            </>
          )}
          {state === "downloading" && (
            <Button disabled variant="default">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>下载中</span>
            </Button>
          )}
          {state === "error" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                改用云端
              </Button>
              <Button onClick={downloadModel}>
                <Download className="h-4 w-4" />
                <span>重试</span>
              </Button>
            </>
          )}
          {state === "unavailable" && (
            <Button onClick={() => onOpenChange(false)}>改用云端</Button>
          )}
          {state === "available" && (
            <Button onClick={() => onOpenChange(false)}>完成</Button>
          )}
          {state === "checking" && (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default LocalTranslatorDialog;
