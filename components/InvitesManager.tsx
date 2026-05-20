"use client";

import * as React from "react";
import { Copy, Gift, Link as LinkIcon, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatInviteCodeForDisplay } from "@/lib/invite";
import { cn } from "@/lib/utils";

interface InviteRow {
  id: string;
  code: string;
  note: string | null;
  isActive: boolean;
  claimCount: number;
  createdAt: string;
  expiresAt: string | null;
}

interface RecentInvitee {
  email: string;
  name: string | null;
  createdAt: string;
}

interface ListResponse {
  referralBonusMinutes: number;
  invitations: InviteRow[];
  recentInvitees: RecentInvitee[];
}

export function InvitesManager() {
  const [data, setData] = React.useState<ListResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [note, setNote] = React.useState("");

  const fetchList = React.useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch("/api/invite/list");
      if (!resp.ok) throw new Error(`${resp.status}`);
      const json = (await resp.json()) as ListResponse;
      setData(json);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void fetchList();
  }, [fetchList]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const resp = await fetch("/api/invite/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() || undefined }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `生成失败 (${resp.status})`);
      }
      setNote("");
      toast.success("邀请码已生成");
      await fetchList();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "生成失败");
    } finally {
      setCreating(false);
    }
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(formatInviteCodeForDisplay(code));
      toast.success("已复制邀请码");
    } catch {
      toast.error("复制失败，请手动选中");
    }
  };

  const copyLink = async (code: string) => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const link = `${origin}/login?invite=${code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("已复制邀请链接");
    } catch {
      toast.error("复制失败，请手动选中");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-zinc-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载中
      </div>
    );
  }
  if (!data) return null;

  const totalClaims = data.invitations.reduce((acc, i) => acc + i.claimCount, 0);
  const activeInvitations = data.invitations.filter((i) => i.isActive);

  return (
    <div className="flex flex-col gap-5">
      {/* Reward summary — the headline incentive: every successful
          invite earns the inviter +60 monthly recording minutes (cap
          configured server-side via REFERRAL_BONUS_MINUTES env). */}
      <section className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-5 dark:border-amber-900/40 dark:from-amber-950/30 dark:to-zinc-900">
        <div className="flex items-center gap-3">
          <Gift className="h-5 w-5 text-amber-500" />
          <div className="flex-1">
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              邀请一位好友 = +60 分钟录音
            </div>
            <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              新用户使用你的邀请码注册成功后，你的本月录音额度自动 +60 分钟。
              已获得的额度跨月保留，永不清零。
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">
              +{data.referralBonusMinutes}
            </div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              已获得分钟
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              生成邀请码
            </div>
            <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              一个邀请码可以被多人使用，每个新用户都会给你 +60 分钟。
            </div>
          </div>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            活跃 {activeInvitations.length} · 累计邀请{" "}
            <span className="font-semibold text-zinc-900 dark:text-zinc-100">
              {totalClaims}
            </span>
          </span>
        </div>
        <div className="mt-4 flex gap-2">
          <Input
            placeholder="备注（可选，例如「给同事」「公众号头条」）"
            value={note}
            maxLength={80}
            onChange={(e) => setNote(e.target.value)}
            disabled={creating}
          />
          <Button onClick={handleCreate} disabled={creating}>
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            生成新邀请码
          </Button>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          我的邀请码（{data.invitations.length}）
        </h2>
        {data.invitations.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400">
            <Gift className="mx-auto mb-2 h-6 w-6 text-zinc-400" />
            还没有生成过邀请码
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.invitations.map((inv) => (
              <InviteRowItem
                key={inv.id}
                inv={inv}
                onCopyCode={copyCode}
                onCopyLink={copyLink}
              />
            ))}
          </ul>
        )}
      </section>

      {data.recentInvitees.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            最近邀请的用户（{data.recentInvitees.length}）
          </h2>
          <ul className="flex flex-col gap-1.5">
            {data.recentInvitees.map((u) => (
              <li
                key={u.email}
                className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900"
              >
                <span className="text-zinc-900 dark:text-zinc-100">
                  {u.name ?? u.email.split("@")[0]}
                </span>
                <span className="text-zinc-500 dark:text-zinc-400">
                  {new Date(u.createdAt).toLocaleDateString("zh-CN")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function InviteRowItem({
  inv,
  onCopyCode,
  onCopyLink,
}: {
  inv: InviteRow;
  onCopyCode: (code: string) => void;
  onCopyLink: (code: string) => void;
}) {
  const expired =
    inv.expiresAt !== null && new Date(inv.expiresAt).getTime() < Date.now();
  const status: "active" | "expired" | "disabled" = !inv.isActive
    ? "disabled"
    : expired
      ? "expired"
      : "active";
  const statusLabel = {
    active: "可用",
    disabled: "已停用",
    expired: "已过期",
  }[status];
  const statusColor = {
    active:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300",
    disabled:
      "border-zinc-200 bg-zinc-100 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-300",
    expired:
      "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300",
  }[status];

  const showActions = status === "active";

  return (
    <li className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-3">
        <code className="flex-1 truncate rounded-md bg-zinc-100 px-3 py-1.5 font-mono text-sm font-medium tracking-wider text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
          {formatInviteCodeForDisplay(inv.code)}
        </code>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[11px] font-medium",
            statusColor
          )}
        >
          {statusLabel}
        </span>
        {showActions ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label="复制邀请码"
              onClick={() => onCopyCode(inv.code)}
            >
              <Copy className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="复制邀请链接"
              onClick={() => onCopyLink(inv.code)}
            >
              <LinkIcon className="h-4 w-4" />
            </Button>
          </>
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        {inv.note ? <span>📝 {inv.note}</span> : null}
        <span>
          已邀请{" "}
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
            {inv.claimCount}
          </span>{" "}
          人
        </span>
        <span>生成于 {new Date(inv.createdAt).toLocaleDateString("zh-CN")}</span>
        {inv.expiresAt && status === "active" ? (
          <span>
            过期于 {new Date(inv.expiresAt).toLocaleDateString("zh-CN")}
          </span>
        ) : null}
      </div>
    </li>
  );
}
