"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { LanguagePicker } from "@/components/LanguagePicker";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";

export interface SettingsState {
  defaultSourceLang: string;
  defaultTargetLang: string;
  contentLang: string;
  theme: "system" | "light" | "dark";
  fontSize: number;
  emailNotifications: boolean;
  desktopNotifications: boolean;
  floatingShowTranslation: boolean;
  floatingFontSize: number;
  floatingWindowWidth: number;
  floatingMaxHistoryItems: number;
}

const DEFAULTS: SettingsState = {
  defaultSourceLang: "en",
  defaultTargetLang: "zh",
  contentLang: "zh",
  theme: "system",
  fontSize: 14,
  emailNotifications: true,
  desktopNotifications: false,
  floatingShowTranslation: true,
  floatingFontSize: 22,
  floatingWindowWidth: 520,
  floatingMaxHistoryItems: 5,
};

export interface SettingsDialogProps {
  /** Controlled open state. Omit to use internal state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional trigger when used uncontrolled. */
  children?: React.ReactNode;
}

export function SettingsDialog({
  open,
  onOpenChange,
  children,
}: SettingsDialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange]
  );

  const [settings, setSettings] = React.useState<SettingsState>(DEFAULTS);
  const [loaded, setLoaded] = React.useState(false);
  const patchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatch = React.useRef<Partial<SettingsState>>({});

  // Load on open
  React.useEffect(() => {
    if (!isOpen || loaded) return;
    let aborted = false;
    (async () => {
      try {
        const res = await fetch("/api/user/settings");
        if (!res.ok) throw new Error("settings-load-failed");
        const data = (await res.json()) as { settings: Partial<SettingsState> | null };
        if (aborted) return;
        if (data.settings) {
          setSettings((prev) => ({ ...prev, ...data.settings }));
        }
      } catch {
        // Phase 1: silent fallback to defaults
      } finally {
        if (!aborted) setLoaded(true);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [isOpen, loaded]);

  // Debounced PATCH on changes
  const queuePatch = React.useCallback((patch: Partial<SettingsState>) => {
    pendingPatch.current = { ...pendingPatch.current, ...patch };
    if (patchTimer.current) clearTimeout(patchTimer.current);
    patchTimer.current = setTimeout(async () => {
      const body = pendingPatch.current;
      pendingPatch.current = {};
      try {
        await fetch("/api/user/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        // Phase 1: silent failure — user can retry by toggling again
      }
    }, 400);
  }, []);

  React.useEffect(() => {
    return () => {
      if (patchTimer.current) clearTimeout(patchTimer.current);
    };
  }, []);

  const update = React.useCallback(
    <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
      setSettings((prev) => ({ ...prev, [key]: value }));
      // Only persist after initial load to avoid clobbering with defaults
      if (loaded) {
        queuePatch({ [key]: value } as Partial<SettingsState>);
        // Track only the key name — values like floatingFontSize go through
        // a debounced slider so per-pixel events would be way too noisy.
        // What we actually want is "which settings users tweak at all".
        track("settings_changed", { key });
      }
    },
    [loaded, queuePatch]
  );

  // Apply theme preference locally for immediate feedback. globals.css
  // only knows about `.dark` (no `.light` class), and the
  // @custom-variant matches `.dark` exactly, so "light" is just the
  // absence of the dark class — strip it explicitly. For "system" we
  // mirror the OS preference so the toggle behaves the same as a fresh
  // load with no user override.
  React.useEffect(() => {
    if (!loaded) return;
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (settings.theme === "dark") {
      root.classList.add("dark");
    } else if (settings.theme === "light") {
      root.classList.remove("dark");
    } else if (typeof window !== "undefined" && window.matchMedia) {
      const prefersDark = window.matchMedia(
        "(prefers-color-scheme: dark)"
      ).matches;
      root.classList.toggle("dark", prefersDark);
    }
  }, [settings.theme, loaded]);

  // Apply body font size — every Tailwind rem-based text utility (text-sm,
  // text-base, text-lg, ...) scales relative to html font-size, so a
  // single style assignment here propagates everywhere. Without this the
  // 字号 slider just stored a number nobody read.
  React.useEffect(() => {
    if (!loaded) return;
    if (typeof document === "undefined") return;
    document.documentElement.style.fontSize = `${settings.fontSize}px`;
  }, [settings.fontSize, loaded]);

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {children}
      {/* On phones cap height to 85vh and let the inner tabs scroll —
          on a 667px iPhone there's not enough vertical room for the
          4-tab settings panel otherwise. */}
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>个性化你的录音、翻译与通知体验</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="general" className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="general">通用</TabsTrigger>
            <TabsTrigger value="style">样式</TabsTrigger>
            <TabsTrigger value="notify">通知</TabsTrigger>
            <TabsTrigger value="floating">悬浮窗</TabsTrigger>
          </TabsList>

          {/* 通用 */}
          <TabsContent value="general" className="space-y-4 pt-2">
            <Row label="默认源语言" hint="新录音默认的识别语言">
              <LanguagePicker
                value={settings.defaultSourceLang}
                onChange={(v) => update("defaultSourceLang", v)}
                ariaLabel="默认源语言"
              />
            </Row>
            <Row label="默认目标语言" hint="翻译时使用的目标语言">
              <LanguagePicker
                value={settings.defaultTargetLang}
                onChange={(v) => update("defaultTargetLang", v)}
                ariaLabel="默认目标语言"
              />
            </Row>
            <Row label="内容语言" hint="AI 总结、对话使用的语言">
              <LanguagePicker
                value={settings.contentLang}
                onChange={(v) => update("contentLang", v)}
                ariaLabel="内容语言"
              />
            </Row>

            <Separator />

            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <Label className="text-sm">新手教程</Label>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  下次进入应用时重新展示引导
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  try {
                    window.localStorage.removeItem("onboarding:completed");
                    // Re-open the tour right away rather than waiting for the
                    // next page load — OnboardingTour listens for this event.
                    window.dispatchEvent(
                      new Event("voice-project:restart-onboarding")
                    );
                  } catch {
                    /* SSR / disabled storage */
                  }
                  toast.success("已重置");
                }}
              >
                重新开始新手教程
              </Button>
            </div>
          </TabsContent>

          {/* 样式 */}
          <TabsContent value="style" className="space-y-4 pt-2">
            <Row label="主题" hint="跟随系统或固定亮 / 暗模式">
              <ThemeRadioGroup
                value={settings.theme}
                onChange={(v) => update("theme", v)}
              />
            </Row>
            <Row label="字号" hint={`${settings.fontSize}px`}>
              <Slider
                value={settings.fontSize}
                min={10}
                max={22}
                step={1}
                onChange={(v) => update("fontSize", v)}
                aria-label="字号"
              />
            </Row>
          </TabsContent>

          {/* 通知 */}
          <TabsContent value="notify" className="space-y-4 pt-2">
            <SwitchRow
              label="邮件通知"
              hint="录音转写完成、AI 总结生成时发送邮件"
              checked={settings.emailNotifications}
              onCheckedChange={(v) => update("emailNotifications", v)}
            />
            <SwitchRow
              label="桌面通知"
              hint="后台运行时在桌面右上角弹出提示"
              checked={settings.desktopNotifications}
              onCheckedChange={async (v) => {
                if (v) {
                  // Permission must be requested in a user-gesture
                  // handler. If the user denied it (or the API is
                  // missing) keep the toggle visually off and stop
                  // here — turning it on without permission means
                  // notifyDesktop() can never fire.
                  const { requestDesktopNotificationPermission } =
                    await import("@/lib/notifications");
                  const perm = await requestDesktopNotificationPermission();
                  if (perm !== "granted") return;
                }
                update("desktopNotifications", v);
              }}
            />
          </TabsContent>

          {/* 悬浮窗 */}
          <TabsContent value="floating" className="space-y-4 pt-2">
            <SwitchRow
              label="显示翻译"
              hint="在悬浮字幕中同时展示译文"
              checked={settings.floatingShowTranslation}
              onCheckedChange={(v) => update("floatingShowTranslation", v)}
            />
            <Row label="悬浮字号" hint={`${settings.floatingFontSize}px`}>
              <Slider
                value={settings.floatingFontSize}
                min={14}
                max={40}
                step={1}
                onChange={(v) => update("floatingFontSize", v)}
                aria-label="悬浮字号"
              />
            </Row>
            <Row label="悬浮窗宽度" hint={`${settings.floatingWindowWidth}px`}>
              <Slider
                value={settings.floatingWindowWidth}
                min={280}
                max={900}
                step={10}
                onChange={(v) => update("floatingWindowWidth", v)}
                aria-label="悬浮窗宽度"
              />
            </Row>
            <Row
              label="历史条目"
              hint={`保留最近 ${settings.floatingMaxHistoryItems} 条`}
            >
              <Slider
                value={settings.floatingMaxHistoryItems}
                min={1}
                max={20}
                step={1}
                onChange={(v) => update("floatingMaxHistoryItems", v)}
                aria-label="历史条目"
              />
            </Row>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/* ---- Local helper components ---- */

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <Label className="text-sm">{label}</Label>
        {hint ? (
          <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {hint}
          </div>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </Row>
  );
}

function ThemeRadioGroup({
  value,
  onChange,
}: {
  value: SettingsState["theme"];
  onChange: (next: SettingsState["theme"]) => void;
}) {
  const options: Array<{ key: SettingsState["theme"]; label: string }> = [
    { key: "system", label: "系统" },
    { key: "light", label: "明亮" },
    { key: "dark", label: "深色" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="主题"
      className="inline-flex rounded-md border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-950"
    >
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          role="radio"
          aria-checked={value === opt.key}
          onClick={() => onChange(opt.key)}
          className={cn(
            "rounded-[6px] px-3 py-1 text-xs font-medium transition-colors",
            value === opt.key
              ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
              : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Slider({
  value,
  min,
  max,
  step,
  onChange,
  "aria-label": ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  "aria-label"?: string;
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label={ariaLabel}
      className="h-1.5 w-44 cursor-pointer appearance-none rounded-full bg-zinc-200 accent-zinc-900 dark:bg-zinc-800 dark:accent-zinc-100"
    />
  );
}

export default SettingsDialog;
