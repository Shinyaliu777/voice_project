"use client";

import * as React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  SUPPORTED_LANGUAGES,
  LANGUAGE_NAMES,
  type SupportedLanguage,
} from "@/lib/contracts";

const FLAGS: Record<SupportedLanguage, string> = {
  en: "🇺🇸",
  zh: "🇨🇳",
  ja: "🇯🇵",
  es: "🇪🇸",
  fr: "🇫🇷",
  de: "🇩🇪",
  ar: "🇸🇦",
  hi: "🇮🇳",
  pt: "🇵🇹",
  ko: "🇰🇷",
  ru: "🇷🇺",
  it: "🇮🇹",
  tr: "🇹🇷",
  vi: "🇻🇳",
  th: "🇹🇭",
  nl: "🇳🇱",
  pl: "🇵🇱",
  sv: "🇸🇪",
  id: "🇮🇩",
  cs: "🇨🇿",
  el: "🇬🇷",
  hu: "🇭🇺",
  ro: "🇷🇴",
  uk: "🇺🇦",
};

export interface LanguagePickerProps {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** Optionally restrict the visible languages (defaults to SUPPORTED_LANGUAGES) */
  options?: ReadonlyArray<SupportedLanguage>;
}

export function LanguagePicker({
  value,
  onChange,
  label,
  ariaLabel,
  disabled,
  options,
}: LanguagePickerProps) {
  const langs = options ?? SUPPORTED_LANGUAGES;
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1">
      {label ? (
        <Label htmlFor={id} className="text-xs text-zinc-500 dark:text-zinc-400">
          {label}
        </Label>
      ) : null}
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          id={id}
          aria-label={ariaLabel ?? label ?? "Language"}
          className="w-[180px]"
        >
          <SelectValue placeholder="Select language" />
        </SelectTrigger>
        <SelectContent>
          {langs.map((code) => (
            <SelectItem key={code} value={code}>
              <span className="mr-2" aria-hidden>
                {FLAGS[code]}
              </span>
              {LANGUAGE_NAMES[code]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export default LanguagePicker;
