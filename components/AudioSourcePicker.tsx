"use client";

import * as React from "react";
import { Mic, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AudioSource } from "@/lib/contracts";

export interface AudioSourcePickerProps {
  value: AudioSource;
  onChange: (v: AudioSource) => void;
  disabled?: boolean;
}

export function AudioSourcePicker({ value, onChange, disabled }: AudioSourcePickerProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <div
        role="radiogroup"
        aria-label="Audio source"
        className="inline-flex items-center rounded-md border border-zinc-200 bg-white p-1 dark:border-zinc-800 dark:bg-zinc-950"
      >
        <Button
          type="button"
          role="radio"
          aria-checked={value === "microphone"}
          variant={value === "microphone" ? "default" : "ghost"}
          size="sm"
          disabled={disabled}
          onClick={() => onChange("microphone")}
          className={cn("gap-2", value === "microphone" ? "" : "text-zinc-600 dark:text-zinc-300")}
        >
          <Mic className="h-4 w-4" />
          <span>Microphone</span>
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              role="radio"
              aria-checked={value === "system"}
              variant={value === "system" ? "default" : "ghost"}
              size="sm"
              disabled={disabled}
              onClick={() => onChange("system")}
              className={cn("gap-2", value === "system" ? "" : "text-zinc-600 dark:text-zinc-300")}
            >
              <Monitor className="h-4 w-4" />
              <span>System Audio</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Chrome desktop only</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

export default AudioSourcePicker;
