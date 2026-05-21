"use client";

import * as React from "react";
import { Copy, Loader2, Plus } from "lucide-react";
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

interface AdminCodeRow {
  id: string;
  code: string;
  codeDisplay: string;
  minutes: number;
  maxUses: number;
  usedCount: number;
  remainingUses: number;
  isActive: boolean;
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
  createdBy: { email: string; name: string | null } | null;
}

interface CodesResponse {
  codes: AdminCodeRow[];
  nextCursor: string | null;
}

export function AdminCodesTab() {
  const [codes, setCodes] = React.useState<AdminCodeRow[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [createOpen, setCreateOpen] = React.useState(false);

  const fetchPage = React.useCallback(async (cur: string | null) => {
    const params = new URLSearchParams();
    if (cur) params.set("cursor", cur);
    const resp = await fetch(`/api/admin/codes?${params}`);
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    return (await resp.json()) as CodesResponse;
  }, []);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchPage(null);
      setCodes(data.codes);
      setCursor(data.nextCursor);
      setHasMore(!!data.nextCursor);
    } catch (err) {
      toast.error(`加载失败：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadMore = async () => {
    if (!cursor) return;
    try {
      const data = await fetchPage(cursor);
      setCodes((prev) => [...prev, ...data.codes]);
      setCursor(data.nextCursor);
      setHasMore(!!data.nextCursor);
    } catch (err) {
      toast.error(`加载更多失败：${(err as Error).message}`);
    }
  };

  const revoke = async (id: string) => {
    setCodes((prev) =>
      prev.map((c) => (c.id === id ? { ...c, isActive: false } : c))
    );
    try {
      const resp = await fetch(`/api/admin/codes/${id}/revoke`, {
        method: "POST",
      });
      if (!resp.ok) throw new Error(`${resp.status}`);
      toast.success("已停用");
    } catch (err) {
      setCodes((prev) =>
        prev.map((c) => (c.id === id ? { ...c, isActive: true } : c))
      );
      toast.error(`失败：${(err as Error).message}`);
    }
  };

  const copy = async (display: string) => {
    try {
      await navigator.clipboard.writeText(display);
      toast.success(`已复制 ${display}`);
    } catch {
      toast.error("复制失败");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          兑换码可以发给用户兑换分钟。一次性或可多次使用都行。
        </p>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" />
          新建兑换码
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
            <tr>
              <th className="px-3 py-2 font-medium">兑换码</th>
              <th className="px-3 py-2 text-right font-medium">分钟</th>
              <th className="px-3 py-2 text-right font-medium">用量</th>
              <th className="px-3 py-2 font-medium">备注</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-12 text-center text-zinc-400"
                >
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            ) : codes.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-12 text-center text-sm text-zinc-400"
                >
                  还没发过兑换码。点右上「新建兑换码」开始。
                </td>
              </tr>
            ) : (
              codes.map((c) => (
                <tr
                  key={c.id}
                  className="border-t border-zinc-100 dark:border-zinc-800"
                >
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => copy(c.codeDisplay)}
                      className="group inline-flex items-center gap-1 rounded font-mono text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      title="点击复制"
                    >
                      <span>{c.codeDisplay}</span>
                      <Copy className="h-3 w-3 opacity-0 group-hover:opacity-60" />
                    </button>
                    <div className="text-[10px] text-zinc-400">
                      {new Date(c.createdAt).toLocaleDateString("zh-CN")}
                      {c.createdBy ? ` · ${c.createdBy.email}` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {c.minutes}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {c.usedCount} / {c.maxUses}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-600 dark:text-zinc-300">
                    {c.note || "—"}
                    {c.expiresAt ? (
                      <div className="text-[10px] text-zinc-400">
                        到期 {new Date(c.expiresAt).toLocaleDateString("zh-CN")}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {!c.isActive ? (
                      <Badge variant="secondary">已停用</Badge>
                    ) : c.remainingUses === 0 ? (
                      <Badge variant="secondary">已用完</Badge>
                    ) : (
                      <Badge>有效</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {c.isActive && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => revoke(c.id)}
                      >
                        停用
                      </Button>
                    )}
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

      <CreateCodeDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void refresh();
        }}
      />
    </div>
  );
}

function CreateCodeDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [minutes, setMinutes] = React.useState("60");
  const [maxUses, setMaxUses] = React.useState("1");
  const [note, setNote] = React.useState("");
  const [prefix, setPrefix] = React.useState("GIFT");
  const [submitting, setSubmitting] = React.useState(false);
  const [lastCreated, setLastCreated] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setMinutes("60");
      setMaxUses("1");
      setNote("");
      setPrefix("GIFT");
      setLastCreated(null);
    }
  }, [open]);

  const submit = async () => {
    const m = Number(minutes);
    const mu = Number(maxUses);
    if (!Number.isInteger(m) || m <= 0) {
      toast.error("分钟数必须是正整数");
      return;
    }
    if (!Number.isInteger(mu) || mu <= 0) {
      toast.error("可使用次数必须是正整数");
      return;
    }
    setSubmitting(true);
    try {
      const resp = await fetch("/api/admin/codes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          minutes: m,
          maxUses: mu,
          note: note || undefined,
          prefix: prefix || undefined,
        }),
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error || `${resp.status}`);
      setLastCreated(body.codeDisplay);
      toast.success(`已生成 ${body.codeDisplay}`);
      // Don't close yet — give the admin a chance to copy the code.
    } catch (err) {
      toast.error(`失败：${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          // If a code was created, treat closing as "done — refresh".
          if (lastCreated) onCreated();
          else onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建兑换码</DialogTitle>
          <DialogDescription>
            生成一个兑换码，发给用户用来加分钟。
          </DialogDescription>
        </DialogHeader>

        {lastCreated ? (
          <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/20">
            <p className="text-sm text-emerald-900 dark:text-emerald-100">
              兑换码已生成。请现在复制，离开此页就关掉提示。
            </p>
            <div className="flex items-center justify-between gap-2 rounded bg-white p-3 font-mono text-lg tracking-wider dark:bg-zinc-900">
              <span>{lastCreated}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(lastCreated);
                    toast.success("已复制");
                  } catch {
                    toast.error("复制失败");
                  }
                }}
              >
                <Copy className="mr-1 h-3.5 w-3.5" />
                复制
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={onCreated}>完成</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">分钟数</Label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={minutes}
                    onChange={(e) => setMinutes(e.target.value)}
                    disabled={submitting}
                  />
                </div>
                <div>
                  <Label className="text-xs">可使用次数</Label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={maxUses}
                    onChange={(e) => setMaxUses(e.target.value)}
                    disabled={submitting}
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs">前缀</Label>
                <Input
                  value={prefix}
                  onChange={(e) =>
                    setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
                  }
                  maxLength={8}
                  placeholder="GIFT"
                  disabled={submitting}
                />
                <p className="mt-1 text-[11px] text-zinc-400">
                  显示格式 PREFIX-XXXX-YYYY，仅字母数字
                </p>
              </div>
              <div>
                <Label className="text-xs">备注（可选）</Label>
                <Textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="例如：发给 Alice、内测补偿"
                  disabled={submitting}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose} disabled={submitting}>
                取消
              </Button>
              <Button onClick={submit} disabled={submitting}>
                {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                生成
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
