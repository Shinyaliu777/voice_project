import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface AppHeaderProps {
  title?: React.ReactNode;
  breadcrumb?: BreadcrumbItem[];
  /** Slot for right-side actions */
  actions?: React.ReactNode;
  className?: string;
}

export function AppHeader({ title, breadcrumb, actions, className }: AppHeaderProps) {
  const hasCrumbs = breadcrumb && breadcrumb.length > 0;
  return (
    <header
      className={cn(
        "flex h-14 items-center justify-between gap-4 border-b border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-zinc-950",
        className
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {hasCrumbs ? (
          <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
            {breadcrumb!.map((item, i) => {
              const last = i === breadcrumb!.length - 1;
              return (
                <React.Fragment key={`${item.label}-${i}`}>
                  {item.href && !last ? (
                    <Link
                      href={item.href}
                      className="hover:text-zinc-900 dark:hover:text-zinc-50"
                    >
                      {item.label}
                    </Link>
                  ) : (
                    <span className={cn(last && "text-zinc-900 dark:text-zinc-50")}>
                      {item.label}
                    </span>
                  )}
                  {!last ? (
                    <ChevronRight className="h-3.5 w-3.5 opacity-60" aria-hidden />
                  ) : null}
                </React.Fragment>
              );
            })}
          </nav>
        ) : null}
        {title ? (
          <div className="truncate text-base font-semibold leading-tight">{title}</div>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export default AppHeader;
