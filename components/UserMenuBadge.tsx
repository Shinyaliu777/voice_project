"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { cn } from "@/lib/utils";

export interface UserMenuBadgeProps {
  className?: string;
}

/**
 * Small chip-style pill that lives in the sidebar header next to the user
 * name. Clicking it opens the UpgradeDialog. Visual: compact, no border,
 * subtle hover background — the goal is to feel like an inline affordance,
 * not a button.
 */
export function UserMenuBadge({ className }: UserMenuBadgeProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="升级套餐"
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
          "text-amber-700 hover:bg-amber-100/60 dark:text-amber-300 dark:hover:bg-amber-900/30",
          "transition-colors",
          className
        )}
      >
        <Sparkles className="h-3 w-3" />
        <span>升级套餐</span>
      </button>
      <UpgradeDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export default UserMenuBadge;
