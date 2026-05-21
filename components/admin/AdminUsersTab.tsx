"use client";

import * as React from "react";
import {
  Loader2,
  ShieldCheck,
  ShieldOff,
  UserMinus,
  UserPlus,
  Plus,
  Minus,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  createdAt: string;
  planName: string;
  monthlyMinutes: number;
  bonusMinutes: number;
  referralBonusMinutes: number;
  referralCount: number;
  sessionCount: number;
  isAdmin: boolean;
  isSuspended: boolean;
}

interface UsersResponse {
  users: AdminUserRow[];
  nextCursor: string | null;
}

/**
 * 用户表 + 操作。所有 mutation 直接更新本地 row（乐观更新）+ toast。
 * 失败时把 row 还原回上一态。
 */
export function AdminUsersTab() {
  const [users, setUsers] = React.useState<AdminUserRow[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [query, setQuery] = React.useState("");
  const [pendingQuery, setPendingQuery] = React.useState("");
  const [grantTarget, setGrantTarget] = React.useState<AdminUserRow | null>(null);
  // Current admin's own email — used to disable admin/suspend buttons
  // on their own row (server refuses with 400 anyway, but a disabled
  // button is friendlier than a toast pop after every click).
  const [myEmail, setMyEmail] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/me/billing")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.user?.email) setMyEmail(data.user.email);
      })
      .catch(() => {
        /* non-fatal — guard still works server-side */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchPage = React.useCallback(
    async (q: string, cur: string | null) => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (cur) params.set("cursor", cur);
      const resp = await fetch(`/api/admin/users?${params}`);
      if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
      return (await resp.json()) as UsersResponse;
    },
    []
  );

  // Initial + on-query-change fetch.
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPage(query, null)
      .then((data) => {
        if (cancelled) return;
        setUsers(data.users);
        setCursor(data.nextCursor);
        setHasMore(!!data.nextCursor);
      })
      .catch((err) => {
        if (!cancelled) toast.error(`加载失败：${(err as Error).message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, fetchPage]);

  const loadMore = async () => {
    if (!cursor) return;
    try {
      const data = await fetchPage(query, cursor);
      setUsers((prev) => [...prev, ...data.users]);
      setCursor(data.nextCursor);
      setHasMore(!!data.nextCursor);
    } catch (err) {
      toast.error(`加载更多失败：${(err as Error).message}`);
    }
  };

  const patchFlag = async (
    user: AdminUserRow,
    flag: "isAdmin" | "isSuspended",
    value: boolean
  ) => {
    // Optimistic
    setUsers((prev) =>
      prev.map((u) => (u.id === user.id ? { ...u, [flag]: value } : u))
    );
    try {
      const resp = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [flag]: value }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `${resp.status}`);
      }
      toast.success(
        flag === "isAdmin"
          ? value
            ? "已设为管理员"
            : "已撤销管理员"
          : value
            ? "已封禁"
            : "已解封"
      );
    } catch (err) {
      // Revert
      setUsers((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, [flag]: !value } : u))
      );
      toast.error(`操作失败：${(err as Error).message}`);
    }
  };

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(pendingQuery.trim());
        }}
        className="flex items-center gap-2"
      >
        <Input
          placeholder="搜索 email / 名字"
          value={pendingQuery}
          onChange={(e) => setPendingQuery(e.target.value)}
          className="max-w-xs"
        />
        <Button type="submit" variant="outline">
          搜索
        </Button>
        {query && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setPendingQuery("");
              setQuery("");
            }}
          >
            清除
          </Button>
        )}
      </form>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
            <tr>
              <th className="px-3 py-2 font-medium">用户</th>
              <th className="px-3 py-2 font-medium">套餐</th>
              <th className="px-3 py-2 text-right font-medium">奖励分钟</th>
              <th className="px-3 py-2 text-right font-medium">推荐</th>
              <th className="px-3 py-2 text-right font-medium">录音数</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-12 text-center text-zinc-400"
                >
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-12 text-center text-sm text-zinc-400"
                >
                  没有匹配的用户
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr
                  key={u.id}
                  className="border-t border-zinc-100 dark:border-zinc-800"
                >
                  <td className="px-3 py-2">
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">
                      {u.name || "(未命名)"}
                    </div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      {u.email}
                    </div>
                    <div className="text-[10px] text-zinc-400">
                      {new Date(u.createdAt).toLocaleDateString("zh-CN")}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-zinc-700 dark:text-zinc-200">
                    {u.planName}
                    <div className="text-[10px] text-zinc-400">
                      {u.monthlyMinutes} 分钟/月
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {u.bonusMinutes + u.referralBonusMinutes}
                    {u.referralBonusMinutes > 0 ? (
                      <div className="text-[10px] text-zinc-400">
                        含推荐 {u.referralBonusMinutes}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-200">
                    {u.referralCount}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-200">
                    {u.sessionCount}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {u.isAdmin && (
                        <Badge variant="default" className="bg-purple-600">
                          Admin
                        </Badge>
                      )}
                      {u.isSuspended && (
                        <Badge variant="destructive">已封禁</Badge>
                      )}
                      {!u.isAdmin && !u.isSuspended && (
                        <span className="text-[11px] text-zinc-400">正常</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      {(() => {
                        // Same-row guard: server refuses self-PATCH on
                        // admin/suspend with 400. Disable here so a click
                        // doesn't even fire — friendlier than a toast.
                        const isSelf = !!myEmail && u.email === myEmail;
                        return (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setGrantTarget(u)}
                              title="加/减分钟"
                            >
                              分钟
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => patchFlag(u, "isAdmin", !u.isAdmin)}
                              disabled={isSelf}
                              title={
                                isSelf
                                  ? "不能改自己的管理员标记"
                                  : u.isAdmin
                                    ? "撤销管理员"
                                    : "设为管理员"
                              }
                            >
                              {u.isAdmin ? (
                                <ShieldOff className="h-3.5 w-3.5" />
                              ) : (
                                <ShieldCheck className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant={u.isSuspended ? "default" : "outline"}
                              onClick={() =>
                                patchFlag(u, "isSuspended", !u.isSuspended)
                              }
                              disabled={isSelf}
                              title={
                                isSelf
                                  ? "不能封禁自己"
                                  : u.isSuspended
                                    ? "解封"
                                    : "封禁"
                              }
                            >
                              {u.isSuspended ? (
                                <UserPlus className="h-3.5 w-3.5" />
                              ) : (
                                <UserMinus className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </>
                        );
                      })()}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="flex justify-center">
          <Button variant="ghost" onClick={loadMore}>
            加载更多
          </Button>
        </div>
      )}

      <GrantMinutesDialog
        target={grantTarget}
        onClose={() => setGrantTarget(null)}
        onApplied={(targetId, newBalance) => {
          setUsers((prev) =>
            prev.map((u) =>
              u.id === targetId ? { ...u, bonusMinutes: newBalance } : u
            )
          );
        }}
      />
    </div>
  );
}

function GrantMinutesDialog({
  target,
  onClose,
  onApplied,
}: {
  target: AdminUserRow | null;
  onClose: () => void;
  onApplied: (userId: string, newBalance: number) => void;
}) {
  const [minutes, setMinutes] = React.useState<string>("60");
  const [reason, setReason] = React.useState<string>("");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (target) {
      setMinutes("60");
      setReason("");
    }
  }, [target]);

  const submit = async (signFlip: 1 | -1) => {
    if (!target) return;
    const m = Number(minutes);
    if (!Number.isInteger(m) || m === 0) {
      toast.error("请输入非零整数");
      return;
    }
    setSubmitting(true);
    try {
      const resp = await fetch(`/api/admin/users/${target.id}/grant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          minutes: m * signFlip,
          reason: reason || undefined,
        }),
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error || `${resp.status}`);
      onApplied(target.id, body.newBalance);
      toast.success(
        `已为 ${target.email} ${signFlip > 0 ? "增加" : "减少"} ${Math.abs(m)} 分钟（余额 ${body.newBalance}）`
      );
      onClose();
    } catch (err) {
      toast.error(`失败：${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>调整分钟数</DialogTitle>
          <DialogDescription>
            {target
              ? `给 ${target.email} 加分钟或扣分钟。每次操作会落一条流水。`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label className="text-xs">分钟数</Label>
            <Input
              type="number"
              inputMode="numeric"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              placeholder="60"
              disabled={submitting}
            />
            <p className="mt-1 text-xs text-zinc-400">
              填正数。点「增加」加分钟，点「减少」扣分钟。
            </p>
          </div>
          <div>
            <Label className="text-xs">原因（可选）</Label>
            <Textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：内测补偿 / 退款"
              disabled={submitting}
            />
          </div>
        </div>
        <DialogFooter className="flex-row gap-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={() => submit(-1)}
            disabled={submitting}
          >
            <Minus className="mr-1 h-3.5 w-3.5" />
            减少
          </Button>
          <Button onClick={() => submit(1)} disabled={submitting}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            增加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
