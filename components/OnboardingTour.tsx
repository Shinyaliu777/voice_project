"use client";

import * as React from "react";
import { ArrowRight, Mic, MessageSquare, Share2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "onboarding:completed";

interface Step {
  icon: React.ReactNode;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    icon: <Mic className="h-8 w-8 text-rose-500" />,
    title: "实时录音 + 同声字幕",
    body:
      "点首页中央的麦克风开始录制，AI 会逐句转写、翻译，支持 60+ 语言。讲话时字幕在屏幕上同步出现。",
  },
  {
    icon: <MessageSquare className="h-8 w-8 text-indigo-500" />,
    title: "AI 自动整理纪要",
    body:
      "讲到一定字数会自动生成章节式纪要，无需手动点击。也可以随时切到「对话」tab，问 AI 这段录音讲了什么。",
  },
  {
    icon: <Share2 className="h-8 w-8 text-emerald-500" />,
    title: "实时分享给同学/同事",
    body:
      "录制中点「实时分享」生成一个公开链接，对方打开浏览器就能看到滚动字幕，无需登录、无需安装。",
  },
];

/**
 * One-shot welcome tour. Shows a centered, 3-step modal on the user's
 * first visit. Persists a flag in localStorage so it doesn't reappear.
 *
 * Trigger sources:
 *   - On mount, when the localStorage flag is unset
 *   - When SettingsDialog's "重新开始新手教程" button removes the flag
 *     and the user reloads (we re-check on mount)
 */
export function OnboardingTour() {
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState(0);

  React.useEffect(() => {
    // Read the flag on mount. SSR-safe because we only check after mount.
    try {
      if (typeof window === "undefined") return;
      const done = window.localStorage.getItem(STORAGE_KEY);
      if (!done) setOpen(true);
    } catch {
      /* localStorage disabled — skip */
    }

    // SettingsDialog dispatches this when the user hits "重新开始新手教程"
    // so we can re-open without a hard page reload.
    const onRestart = () => {
      setStep(0);
      setOpen(true);
    };
    window.addEventListener("voice-project:restart-onboarding", onRestart);
    return () =>
      window.removeEventListener("voice-project:restart-onboarding", onRestart);
  }, []);

  const dismiss = React.useCallback(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    } catch {
      /* ignore */
    }
    setOpen(false);
  }, []);

  if (!open) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-950/40 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="relative w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
        <button
          type="button"
          onClick={dismiss}
          aria-label="跳过"
          className="absolute right-3 top-3 rounded-full p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-zinc-100 dark:bg-zinc-900">
          {current.icon}
        </div>
        <h2
          id="onboarding-title"
          className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
        >
          {current.title}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
          {current.body}
        </p>

        {/* Step dots */}
        <div className="mt-6 flex items-center justify-center gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === step
                  ? "w-6 bg-zinc-900 dark:bg-zinc-50"
                  : "w-1.5 bg-zinc-200 dark:bg-zinc-800"
              )}
            />
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <Button variant="ghost" size="sm" onClick={dismiss}>
            跳过
          </Button>
          <Button
            size="sm"
            onClick={() => (isLast ? dismiss() : setStep(step + 1))}
          >
            {isLast ? "开始使用" : "下一步"}
            {!isLast && <ArrowRight className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default OnboardingTour;
