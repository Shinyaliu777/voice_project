import Link from "next/link";
import { ArrowLeft, Check, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/dev-user";
import { getQuota } from "@/lib/quota";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

function fmtCents(cents: number): string {
  if (cents === 0) return "免费";
  // Pricing is stored in USD cents (matches lecsync's schema).
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtMinutes(n: number): string {
  if (n >= 100_000) return "无限";
  return `${n.toLocaleString()} 分钟 / 月`;
}

function fmtChat(n: number): string {
  if (n === 0) return "无限对话";
  return `${n} 条 / 天`;
}

export default async function BillingPage() {
  const userId = await requireUserId();

  const [plans, sub, recording, chat] = await Promise.all([
    prisma.plan.findMany({
      where: { isActive: true },
      orderBy: [{ monthlyPriceCents: "asc" }, { name: "asc" }],
    }),
    prisma.subscription.findUnique({
      where: { userId },
      include: { plan: true },
    }),
    getQuota(userId, "recording"),
    getQuota(userId, "chat"),
  ]);

  const currentPlanId =
    sub?.planId ?? plans.find((p) => p.isDefault)?.id ?? plans[0]?.id;

  return (
    <div className="mx-auto max-w-3xl px-3 py-6 sm:px-4 md:max-w-4xl md:px-6 md:py-8 lg:px-8">
      <div className="mb-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700"
        >
          <ArrowLeft className="h-4 w-4" />
          返回首页
        </Link>
      </div>

      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          套餐与用量
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          当前套餐、本月已用 · 升级套餐解锁更多录音时长与对话条数
        </p>
      </header>

      {/* Current usage */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="text-base">本期用量</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <UsageBar
            label="本月录音"
            used={recording.used}
            limit={recording.limit}
            unit="分钟"
            unlimited={!isFinite(recording.remaining)}
          />
          <UsageBar
            label="今日 AI 对话"
            used={chat.used}
            limit={chat.limit}
            unit="条"
            unlimited={!isFinite(chat.remaining)}
          />
        </CardContent>
      </Card>

      {/* Plans */}
      <h2 className="mb-3 text-base font-medium text-zinc-700 dark:text-zinc-200">
        套餐
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {plans.map((p) => {
          const isCurrent = p.id === currentPlanId;
          return (
            <Card
              key={p.id}
              className={cn(
                "relative",
                isCurrent && "border-zinc-900 dark:border-zinc-50"
              )}
            >
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base">
                  <span className="flex items-center gap-2">
                    {p.displayName}
                    {p.isPremium && (
                      <Sparkles className="h-4 w-4 text-amber-500" />
                    )}
                  </span>
                  {isCurrent && (
                    <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] font-normal text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900">
                      当前套餐
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                    {fmtCents(p.monthlyPriceCents)}
                    {p.monthlyPriceCents > 0 && (
                      <span className="ml-1 text-sm font-normal text-zinc-500">
                        / 月
                      </span>
                    )}
                  </div>
                  {p.yearlyPriceCents > 0 && (
                    <p className="mt-1 text-xs text-zinc-500">
                      年付 {fmtCents(p.yearlyPriceCents)}（约 ${(p.yearlyPriceCents / 1200).toFixed(2)}/月）
                    </p>
                  )}
                  {p.description && (
                    <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
                      {p.description}
                    </p>
                  )}
                </div>
                <ul className="space-y-1.5 text-sm">
                  <Feat ok>录音 · {fmtMinutes(p.monthlyMinutes)}</Feat>
                  <Feat ok>AI 对话 · {fmtChat(p.dailyChatMessages)}</Feat>
                  {p.cloudTranslationIncluded ? (
                    <Feat ok>云端翻译（Soniox two-way）</Feat>
                  ) : (
                    <Feat>仅本地翻译</Feat>
                  )}
                  {p.isPremium && <Feat ok>Pro 模型 (DeepSeek V4-Pro 推理)</Feat>}
                </ul>
                {isCurrent ? (
                  <Button variant="outline" disabled className="w-full">
                    当前套餐
                  </Button>
                ) : p.monthlyPriceCents === 0 ? (
                  <Button variant="outline" disabled className="w-full">
                    免费档（默认）
                  </Button>
                ) : (
                  <Button disabled className="w-full" title="Stripe 接入中">
                    升级 · 即将上线
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="mt-8 text-xs text-zinc-400">
        Stripe 结算尚未接入 — 升级按钮会在 Wave 2.2 完成后启用。
        详见{" "}
        <Link
          href="https://github.com/Shinyaliu777/voice_project/blob/main/docs/LECSYNC_REVERSE_ENGINEERING.md"
          className="underline"
        >
          docs/LECSYNC_REVERSE_ENGINEERING.md §8
        </Link>
        。
      </p>
    </div>
  );
}

function UsageBar({
  label,
  used,
  limit,
  unit,
  unlimited,
}: {
  label: string;
  used: number;
  limit: number;
  unit: string;
  unlimited: boolean;
}) {
  const pct = unlimited
    ? 0
    : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between text-sm">
        <span className="text-zinc-700 dark:text-zinc-200">{label}</span>
        <span className="font-mono text-xs tabular-nums text-zinc-500">
          {used.toLocaleString()} / {unlimited ? "∞" : limit.toLocaleString()} {unit}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            pct >= 90
              ? "bg-rose-500"
              : pct >= 70
                ? "bg-amber-500"
                : "bg-zinc-700 dark:bg-zinc-300"
          )}
          style={{ width: `${unlimited ? 0 : pct}%` }}
        />
      </div>
    </div>
  );
}

function Feat({
  ok,
  children,
}: {
  ok?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2">
      <Check
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          ok ? "text-emerald-500" : "text-zinc-300 dark:text-zinc-700"
        )}
      />
      <span className={cn(ok ? "" : "text-zinc-400 line-through")}>{children}</span>
    </li>
  );
}
