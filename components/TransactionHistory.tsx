"use client";

import * as React from "react";
import {
  Gift,
  Loader2,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Transaction {
  id: string;
  delta: number;
  kind: string;
  description: string;
  balanceAfter: number;
  createdAt: string;
}

interface PageResp {
  transactions: Transaction[];
  nextCursor: string | null;
}

/**
 * "查看历史交易流水记录" — collapsible card on /dashboard/billing.
 * Lazy-loads on first expand so the billing page itself stays fast.
 * Paginated with a cursor (load more button at the bottom).
 */
export function TransactionHistory() {
  const [open, setOpen] = React.useState(false);
  const [rows, setRows] = React.useState<Transaction[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [loadedOnce, setLoadedOnce] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fetchPage = React.useCallback(async (cur: string | null) => {
    const params = new URLSearchParams();
    if (cur) params.set("cursor", cur);
    const resp = await fetch(`/api/me/transactions?${params}`);
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    return (await resp.json()) as PageResp;
  }, []);

  const initialLoad = React.useCallback(async () => {
    if (loadedOnce) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPage(null);
      setRows(data.transactions);
      setCursor(data.nextCursor);
      setHasMore(!!data.nextCursor);
      setLoadedOnce(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [fetchPage, loadedOnce]);

  const loadMore = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const data = await fetchPage(cursor);
      setRows((prev) => [...prev, ...data.transactions]);
      setCursor(data.nextCursor);
      setHasMore(!!data.nextCursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    if (open && !loadedOnce) void initialLoad();
  }, [open, loadedOnce, initialLoad]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-zinc-500" />
            历史交易流水
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "收起" : "查看"}
          </Button>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent>
          {!loadedOnce && loading ? (
            <div className="py-6 text-center text-zinc-400">
              <Loader2 className="mx-auto h-5 w-5 animate-spin" />
            </div>
          ) : error ? (
            <p className="py-4 text-center text-sm text-rose-500">{error}</p>
          ) : rows.length === 0 ? (
            <p className="py-4 text-center text-sm text-zinc-400">
              没有任何分钟变动记录。
            </p>
          ) : (
            <>
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {rows.map((r) => (
                  <TxRow key={r.id} tx={r} />
                ))}
              </ul>
              {hasMore && (
                <div className="mt-3 flex justify-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={loadMore}
                    disabled={loading}
                  >
                    {loading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      "加载更多"
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function TxRow({ tx }: { tx: Transaction }) {
  const Icon = pickIcon(tx.kind);
  const sign = tx.delta >= 0 ? "+" : "";
  const color =
    tx.delta >= 0
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400";
  return (
    <li className="flex items-center gap-3 py-2">
      <div className="rounded-md bg-zinc-100 p-1.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-zinc-700 dark:text-zinc-200">
          {tx.description}
        </div>
        <div className="text-[10px] text-zinc-400">
          {new Date(tx.createdAt).toLocaleString("zh-CN", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      </div>
      <div className="text-right">
        <div className={`font-mono text-sm tabular-nums ${color}`}>
          {sign}
          {tx.delta} 分钟
        </div>
        <div className="text-[10px] text-zinc-400">
          余额 {tx.balanceAfter}
        </div>
      </div>
    </li>
  );
}

function pickIcon(kind: string) {
  switch (kind) {
    case "redemption":
      return Gift;
    case "admin_grant":
    case "admin_deduct":
      return ShieldCheck;
    case "referral_bonus":
      return Sparkles;
    default:
      return TrendingUp;
  }
}
