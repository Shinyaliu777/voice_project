"use client";

import * as React from "react";
import { Copy, Gift, Link as LinkIcon, Loader2, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface InviteRow {
  id: string;
  code: string;
  note: string | null;
  status: "pending" | "claimed" | "expired";
  createdAt: string;
  expiresAt: string | null;
  claimedAt: string | null;
  claimedBy: { email: string; name: string | null } | null;
}

interface ListResponse {
  invitationsRemaining: number;
  invitations: InviteRow[];
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
    if (!data || data.invitationsRemaining <= 0) {
      toast.error("邀请额度已用完");
      return;
    }
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
      await navigator.clipboard.writeText(code);
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

  const hasQuota = data.invitationsRemaining > 0;

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            剩余邀请额度
          </span>
          <span className="ml-auto text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
            {data.invitationsRemaining}
          </span>
        </div>
        {hasQuota ? (
          <>
            <div className="mt-4 flex gap-2">
              <Input
                placeholder="备注（可选，例如 「给同事」）"
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
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              生成后请尽快分享 — 30 天未使用会自动过期。
            </p>
          </>
        ) : (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            额度已用完。如需更多名额，请联系管理员。
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          我生成的邀请码（{data.invitations.length}）
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
  const statusLabel: Record<InviteRow["status"], string> = {
    pending: "未使用",
    claimed: "已使用",
    expired: "已过期",
  };
  const statusColor: Record<InviteRow["status"], string> = {
    pending:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300",
    claimed:
      "border-zinc-200 bg-zinc-100 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-300",
    expired:
      "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300",
  };
  const showActions = inv.status === "pending";
  return (
    <li className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-3">
        <code className="flex-1 truncate rounded-md bg-zinc-100 px-3 py-1.5 font-mono text-sm font-medium tracking-wider text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
          {inv.code}
        </code>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[11px] font-medium",
            statusColor[inv.status]
          )}
        >
          {statusLabel[inv.status]}
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
        <span>生成于 {new Date(inv.createdAt).toLocaleString("zh-CN")}</span>
        {inv.status === "claimed" && inv.claimedBy ? (
          <span>
            被 {inv.claimedBy.name ?? inv.claimedBy.email} 使用
          </span>
        ) : inv.expiresAt && inv.status === "pending" ? (
          <span>
            过期于 {new Date(inv.expiresAt).toLocaleDateString("zh-CN")}
          </span>
        ) : null}
      </div>
    </li>
  );
}
