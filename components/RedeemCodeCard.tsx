"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Gift, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * 兑换码输入卡片。落地在 /dashboard/billing 里，对应 lecsync
 * 截图里的「兑换码」一行。成功兑换后调用 router.refresh() 让
 * 服务端组件重新拉一次余额，旁边的 UsageBar 就跟着更新。
 */
export function RedeemCodeCard() {
  const [code, setCode] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const router = useRouter();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      const resp = await fetch("/api/me/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      const body = await resp.json();
      if (!resp.ok) {
        toast.error(body.error || "兑换失败");
        return;
      }
      toast.success(`兑换成功：+${body.minutesGranted} 分钟`);
      setCode("");
      // Re-render the server-side billing page so the new balance shows.
      router.refresh();
    } catch (err) {
      toast.error(`兑换失败：${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gift className="h-4 w-4 text-emerald-500" />
          兑换码
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex items-center gap-2">
          <Input
            placeholder="输入兑换码（如 GIFT-AB12-CD34）"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={submitting}
            className="font-mono uppercase"
            autoComplete="off"
          />
          <Button type="submit" disabled={submitting || !code.trim()}>
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "兑换"
            )}
          </Button>
        </form>
        <p className="mt-2 text-[11px] text-zinc-400">
          管理员发的兑换码可以加分钟。每个码每用户只能兑换一次。
        </p>
      </CardContent>
    </Card>
  );
}
