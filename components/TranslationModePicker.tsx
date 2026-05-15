"use client";

import * as React from "react";
import { ChevronDown, Cloud, Shield, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isChromeTranslatorAvailable } from "@/lib/translation/chrome-local";
import type { TranslationMode } from "@/lib/contracts";

export interface TranslationModePickerProps {
  value: TranslationMode;
  onChange: (v: TranslationMode) => void;
  disabled?: boolean;
}

interface ModeOption {
  value: TranslationMode;
  label: string;
  subtitle: string;
  icon: React.ReactNode;
}

const OPTIONS: ReadonlyArray<ModeOption> = [
  {
    value: "off",
    label: "关闭翻译",
    subtitle: "不翻译，仅转录",
    icon: <Ban className="h-4 w-4" />,
  },
  {
    value: "local",
    label: "本地翻译",
    subtitle: "隐私优先，Chrome 138+",
    icon: <Shield className="h-4 w-4" />,
  },
  {
    value: "cloud",
    label: "云端翻译",
    subtitle: "高质量，所有浏览器",
    icon: <Cloud className="h-4 w-4" />,
  },
];

export function TranslationModePicker({
  value,
  onChange,
  disabled,
}: TranslationModePickerProps) {
  const [localAvailable, setLocalAvailable] = React.useState<boolean>(true);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const ok = await isChromeTranslatorAvailable();
        if (alive) setLocalAvailable(Boolean(ok));
      } catch {
        if (alive) setLocalAvailable(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];

  return (
    <TooltipProvider delayDuration={200}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="gap-2"
          >
            <span className="flex items-center gap-2">
              {current.icon}
              <span>{current.label}</span>
            </span>
            <ChevronDown className="h-4 w-4 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(v) => onChange(v as TranslationMode)}
          >
            {OPTIONS.map((opt) => {
              const disabledItem = opt.value === "local" && !localAvailable;
              const item = (
                <DropdownMenuRadioItem
                  key={opt.value}
                  value={opt.value}
                  disabled={disabledItem}
                  className={cn("py-2", disabledItem && "opacity-60")}
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 text-zinc-600 dark:text-zinc-300">{opt.icon}</span>
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">{opt.label}</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        {opt.subtitle}
                      </span>
                    </div>
                  </div>
                </DropdownMenuRadioItem>
              );
              if (disabledItem) {
                return (
                  <Tooltip key={opt.value}>
                    <TooltipTrigger asChild>
                      <span className="block">{item}</span>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      需要 Chrome 138+ 的 Translator API
                    </TooltipContent>
                  </Tooltip>
                );
              }
              return item;
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}

export default TranslationModePicker;
