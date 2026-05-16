import * as React from "react";
import { cn } from "@/lib/utils";

export interface AppHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Slot for right-side actions */
  actions?: React.ReactNode;
  className?: string;
}

export function AppHeader({ title, subtitle, actions, className }: AppHeaderProps) {
  return (
    <header
      className={cn(
        "mb-8 flex flex-wrap items-end justify-between gap-4",
        className
      )}
    >
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

export default AppHeader;
