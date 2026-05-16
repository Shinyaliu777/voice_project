"use client";

import * as React from "react";
import { Copy, Link as LinkIcon, Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";

interface InviteData {
  inviteCode: string;
  invitedCount: number;
  earnedMinutes: number;
  maxMinutes: number;
}

export interface InviteCodeCardProps {
  className?: string;
}

export function InviteCodeCard({ className }: InviteCodeCardProps) {
  const [data, setData] = React.useState<InviteData | null>(null);

  React.useEffect(() => {
    let aborted = false;
    (async () => {
      try {
        const res = await fetch("/api/invite/list");
        if (!res.ok) return;
        const json = (await res.json()) as InviteData;
        if (!aborted) setData(json);
      } catch {
        // silent — card simply shows placeholders
      }
    })();
    return () => {
      aborted = true;
    };
  }, []);

  const copyCode = async () => {
    if (!data) return;
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    const link = `${origin}/?invite=${data.inviteCode}`;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("已复制邀请链接");
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  const copyLink = async () => {
    if (!data) return;
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    const link = `${origin}/?invite=${data.inviteCode}`;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("已复制邀请链接");
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  return (
    <div
      className={cn(
        "mx-3 mb-3 rounded-lg border border-zinc-200 bg-white/70 p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60",
        className
      )}
    >
      <div className="flex items-center gap-1.5">
        <Gift className="h-3.5 w-3.5 text-amber-500" />
        <div className="text-[12px] font-semibold text-zinc-900 dark:text-zinc-100">
          邀请奖励
        </div>
      </div>
      <div className="mt-1 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
        每邀请一位好友完成首录 +60 min（上限 1500）
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-600 dark:text-zinc-300">
        <span>
          已邀请{" "}
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
            {data?.invitedCount ?? 0}
          </span>{" "}
          人
        </span>
        <span>
          已获得{" "}
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
            {data?.earnedMinutes ?? 0}
          </span>{" "}
          分钟
        </span>
      </div>

      <div className="mt-2 flex items-center gap-1">
        <code className="flex-1 truncate rounded-md bg-zinc-100 px-2 py-1 text-[11px] font-medium tabular-nums text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
          {data?.inviteCode ?? "·····"}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="复制邀请码"
          className="h-7 w-7"
          onClick={copyCode}
          disabled={!data}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="复制邀请链接"
          className="h-7 w-7"
          onClick={copyLink}
          disabled={!data}
        >
          <LinkIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export default InviteCodeCard;
