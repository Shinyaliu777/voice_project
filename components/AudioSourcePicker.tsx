"use client";

import * as React from "react";
import { AlertTriangle, Mic, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AudioSource } from "@/lib/contracts";

export interface AudioSourcePickerProps {
  value: AudioSource;
  onChange: (v: AudioSource) => void;
  disabled?: boolean;
}

type MicPermissionState = "unknown" | "prompt" | "granted" | "denied";

export function AudioSourcePicker({ value, onChange, disabled }: AudioSourcePickerProps) {
  const [micPermission, setMicPermission] =
    React.useState<MicPermissionState>("unknown");

  React.useEffect(() => {
    let active = true;
    let permissionStatus: PermissionStatus | null = null;

    async function probe() {
      if (typeof navigator === "undefined" || !navigator.permissions) {
        return;
      }
      try {
        // Use unknown for cross-browser PermissionName narrowing
        const status = await navigator.permissions.query({
          name: "microphone" as PermissionName,
        });
        if (!active) return;
        permissionStatus = status;
        setMicPermission(status.state as MicPermissionState);
        status.onchange = () => {
          if (!active) return;
          setMicPermission(status.state as MicPermissionState);
        };
      } catch {
        // Some browsers (Safari) reject 'microphone' as a query name; treat as unknown
      }
    }

    probe();

    return () => {
      active = false;
      if (permissionStatus) permissionStatus.onchange = null;
    };
  }, []);

  if (micPermission === "denied") {
    return (
      <div
        role="alert"
        className={cn(
          "inline-flex items-start gap-2 rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700",
          "dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
        )}
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">麦克风权限被拒绝</span>
          <span className="text-red-600/80 dark:text-red-300/80">
            请在浏览器地址栏左侧的站点设置中允许麦克风访问后刷新页面。
          </span>
        </div>
      </div>
    );
  }

  const PillButton: React.FC<{
    source: AudioSource;
    icon: React.ReactNode;
    label: string;
  }> = ({ source, icon, label }) => {
    const active = value === source;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={active}
        disabled={disabled}
        onClick={() => onChange(source)}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-[10px] px-3 text-xs font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-1",
          "disabled:pointer-events-none disabled:opacity-50",
          active
            ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
            : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
        )}
      >
        <span className="[&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>
        <span>{label}</span>
      </button>
    );
  };

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <div
        role="radiogroup"
        aria-label="Audio source"
        className="inline-flex items-center gap-1.5"
      >
        <PillButton
          source="microphone"
          icon={<Mic />}
          label="Microphone"
        />
        <PillButton
          source="system"
          icon={<Monitor />}
          label="System Audio"
        />
      </div>
      {value === "system" ? (
        <span className="px-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          Chrome 桌面端可用
        </span>
      ) : null}
    </div>
  );
}

export default AudioSourcePicker;
