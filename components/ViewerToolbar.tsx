"use client";

import * as React from "react";
import {
  Check,
  Copy,
  Download,
  Languages,
  Moon,
  MoreVertical,
  Sun,
  Type,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LANGUAGE_NAMES,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "@/lib/contracts";
import { cn } from "@/lib/utils";

export type FontScalePreset = "S" | "M" | "L" | "XL";

export const FONT_SCALE_VALUES: Record<FontScalePreset, number> = {
  S: 0.85,
  M: 1.0,
  L: 1.25,
  XL: 1.5,
};

const FONT_SCALE_ORDER: FontScalePreset[] = ["S", "M", "L", "XL"];

export interface ViewerToolbarProps {
  /** "live · X 主持人正在录制" / "已暂停" / "断开连接 · 重连中…" */
  statusLabel: string;
  statusTone: "live" | "paused" | "disconnected";
  /** Current viewer-side target language (BCP-47). */
  viewerLang: SupportedLanguage;
  onViewerLangChange: (next: SupportedLanguage) => void;
  /** When true, viewer-side re-translation is disabled and host's
   *  translation is shown verbatim. The lang Select is dimmed but kept
   *  visible so the user can see/remember their previous override. */
  followHost: boolean;
  onFollowHostChange: (next: boolean) => void;
  /** Active font-scale preset. */
  fontScale: FontScalePreset;
  onFontScaleChange: (next: FontScalePreset) => void;
  /** "light" | "dark". */
  theme: "light" | "dark";
  onThemeToggle: () => void;
  onCopyAll: () => void;
  onDownloadMd: () => void;
}

export function ViewerToolbar({
  statusLabel,
  statusTone,
  viewerLang,
  onViewerLangChange,
  followHost,
  onFollowHostChange,
  fontScale,
  onFontScaleChange,
  theme,
  onThemeToggle,
  onCopyAll,
  onDownloadMd,
}: ViewerToolbarProps) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    onCopyAll();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <StatusPill tone={statusTone} label={statusLabel} />

      {/* Follow-host toggle. When on (default), the viewer just shows the
          host's translation verbatim — which is what makes host & viewer
          match. Off lets the viewer re-translate locally via Chrome
          Translator, which is intentionally a different translation. */}
      <button
        type="button"
        onClick={() => onFollowHostChange(!followHost)}
        aria-pressed={followHost}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
          followHost
            ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
            : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400"
        )}
      >
        {followHost ? "跟随主持人" : "自选译文"}
      </button>

      <Select
        value={viewerLang}
        onValueChange={(v) => {
          // Choosing a language implicitly opts out of follow-host so the
          // re-translation actually runs.
          if (followHost) onFollowHostChange(false);
          onViewerLangChange(v as SupportedLanguage);
        }}
        disabled={followHost}
      >
        <SelectTrigger
          aria-label="译文语言"
          className={cn(
            "h-8 w-auto gap-1.5 px-2.5 text-xs",
            followHost && "opacity-50"
          )}
        >
          <Languages className="h-3.5 w-3.5 opacity-70" aria-hidden />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SUPPORTED_LANGUAGES.map((lang) => (
            <SelectItem key={lang} value={lang}>
              {LANGUAGE_NAMES[lang]}
              <span className="ml-2 text-xs text-zinc-400">
                {lang.toUpperCase()}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div
        className="inline-flex h-8 items-center gap-0.5 rounded-md border border-zinc-200 bg-white px-1 dark:border-zinc-800 dark:bg-zinc-950"
        role="group"
        aria-label="字号"
      >
        <Type
          className="ml-0.5 h-3.5 w-3.5 text-zinc-400"
          aria-hidden
        />
        {FONT_SCALE_ORDER.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-label={`字号 ${preset}`}
            aria-pressed={fontScale === preset}
            onClick={() => onFontScaleChange(preset)}
            className={cn(
              "rounded-sm px-1.5 text-xs font-medium leading-none transition-colors",
              fontScale === preset
                ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            )}
            style={{ height: 22 }}
          >
            {preset}
          </button>
        ))}
      </div>

      <Button
        type="button"
        size="icon"
        variant="outline"
        onClick={onThemeToggle}
        aria-label={theme === "dark" ? "切换到浅色" : "切换到深色"}
        className="h-8 w-8"
      >
        {theme === "dark" ? (
          <Sun className="h-4 w-4" />
        ) : (
          <Moon className="h-4 w-4" />
        )}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label="更多操作"
            className="h-8 w-8"
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>导出</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleCopy}>
            {copied ? (
              <>
                <Check className="h-4 w-4 text-emerald-500" />
                <span>已复制</span>
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" />
                <span>复制全部</span>
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onDownloadMd}>
            <Download className="h-4 w-4" />
            <span>下载 .md</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function StatusPill({
  tone,
  label,
}: {
  tone: ViewerToolbarProps["statusTone"];
  label: string;
}) {
  const dot =
    tone === "live"
      ? "bg-rose-500 animate-pulse"
      : tone === "paused"
        ? "bg-amber-500"
        : "bg-zinc-400";
  const text =
    tone === "live"
      ? "text-rose-700 dark:text-rose-300"
      : tone === "paused"
        ? "text-amber-700 dark:text-amber-300"
        : "text-zinc-500 dark:text-zinc-400";
  const border =
    tone === "live"
      ? "border-rose-200 dark:border-rose-900/60"
      : tone === "paused"
        ? "border-amber-200 dark:border-amber-900/60"
        : "border-zinc-200 dark:border-zinc-800";
  return (
    <span
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md border bg-white px-2.5 text-xs font-medium dark:bg-zinc-950",
        text,
        border
      )}
    >
      <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden />
      <span className="whitespace-nowrap">{label}</span>
    </span>
  );
}

export default ViewerToolbar;
