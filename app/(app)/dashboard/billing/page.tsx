import Link from "next/link";
import { ArrowLeft, Check, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/dev-user";
import { getQuota, getRecordingBreakdown } from "@/lib/quota";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Mirrors lib/quota.ts — anything north of this on a Plan's
// monthlyMinutes is treated as "effectively unlimited" and we render
// ∞ / no progress bar instead of a misleadingly empty 6 / 999999 ratio.
const RECORDING_UNLIMITED_THRESHOLD = 100_000;

function fmtCents(cents: number): string {
  if (cents === 0) return "免费";
  // Pricing is stored in USD cents (matches lecsync's schema).
  return `$${(cents / 100).toFixed(2)}`;
}

/** "X 天后重置" for monthly recording quota (server-clock based). */
function resetInForRecording(): string {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const days = Math.max(
    1,
    Math.ceil((nextMonth.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
  );
  return `${days} 天后重置`;
}

/** "X 小时后重置" for daily chat quota. Falls back to "1 小时" min so
 *  we never render "0 小时后重置" right before midnight. */
function resetInForChat(): string {
  const now = new Date();
  const tomorrow = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1
  );
  const hours = Math.max(
    1,
    Math.ceil((tomorrow.getTime() - now.getTime()) / (1000 * 60 * 60))
  );
  return `${hours} 小时后重置`;
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

  const [plans, sub, recording, chat, breakdown] = await Promise.all([
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
    getRecordingBreakdown(userId),
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
            unlimited={recording.limit >= RECORDING_UNLIMITED_THRESHOLD}
            resetIn={resetInForRecording()}
          />
          <UsageBar
            label="今日 AI 对话"
            used={chat.used}
            limit={chat.limit}
            unit="条"
            unlimited={chat.limit === 0}
            resetIn={resetInForChat()}
          />
        </CardContent>
      </Card>

      {/* Audit table — exposes the per-session math behind the bar so
          users can verify "本月录音" themselves. Native <details> so
          it stays server-rendered and zero-JS; click to expand. */}
      {breakdown.length > 0 ? (
        <details className="mb-8 rounded-lg border border-zinc-200 bg-white open:shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <summary className="cursor-pointer select-none rounded-lg px-4 py-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800">
            本期用量明细（{breakdown.length} 个录音 · 合计 {breakdown
              .reduce((a, b) => a + b.minutes, 0)
              .toFixed(2)} 分钟）
          </summary>
          <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <table className="w-full text-xs">
              <thead className="text-left text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                <tr>
                  <th className="pb-2 font-medium">录音</th>
                  <th className="pb-2 font-medium">状态</th>
                  <th className="pb-2 text-right font-medium">分钟</th>
                  <th className="pb-2 pl-3 font-medium">来源</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((c) => (
                  <tr
                    key={c.sessionId}
                    className="border-t border-zinc-100 dark:border-zinc-800"
                  >
                    <td className="py-2 pr-3">
                      <Link
                        href={`/dashboard/history/${c.sessionId}`}
                        className="text-zinc-700 hover:underline dark:text-zinc-200"
                      >
                        {c.title || "未命名录音"}
                      </Link>
                      <div className="text-[10px] text-zinc-400 dark:text-zinc-500">
                        {c.createdAt.toLocaleString("zh-CN", {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-zinc-500 dark:text-zinc-400">
                      {c.status}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-200">
                      {c.minutes.toFixed(2)}
                    </td>
                    <td className="py-2 pl-3 text-zinc-400 dark:text-zinc-500">
                      {c.source === "durationMs"
                        ? "录音时长"
                        : c.source === "chunks"
                          ? "音频块累计"
                          : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[11px] text-zinc-400 dark:text-zinc-500">
              用量按录音的墙钟时长算，包含沉默 ——「录音时长」= finalize 时
              客户端记录的真实录音时长；「音频块累计」= 未 finalize 的录音，
              用已上传的 3 秒一个音频块累计而成；「—」= 该 session 没真录到
              任何内容（贡献 0 分钟）。
            </p>
          </div>
        </details>
      ) : null}

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
  resetIn,
}: {
  label: string;
  used: number;
  limit: number;
  unit: string;
  unlimited: boolean;
  resetIn?: string;
}) {
  const rawPct = unlimited
    ? 0
    : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  // When used > 0 but the ratio rounds down to under ~2%, the filled
  // segment is so short it looks empty — users reported "进度条没填".
  // Floor at 2.5% for any non-zero usage so a tiny sliver is always
  // visible, while ratios above that stay accurate.
  const displayPct = !unlimited && used > 0 && rawPct < 2.5 ? 2.5 : rawPct;
  const remaining = unlimited
    ? null
    : Math.max(0, limit - used);
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2 text-sm">
        <span className="text-zinc-700 dark:text-zinc-200">{label}</span>
        <span className="font-mono text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
          {used.toLocaleString()} / {unlimited ? "∞" : limit.toLocaleString()} {unit}
        </span>
      </div>
      {/* Stronger track contrast — bg-zinc-100/zinc-900 used to blend
          into the Card surface in dark mode so the bar looked invisible
          when usage was tiny. zinc-200/zinc-800 reads as an actual
          channel against either Card background. */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            rawPct >= 90
              ? "bg-rose-500"
              : rawPct >= 70
                ? "bg-amber-500"
                : "bg-zinc-700 dark:bg-zinc-300"
          )}
          style={{ width: `${unlimited ? 0 : displayPct}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>
          {unlimited
            ? "无限额度"
            : remaining === 0
              ? "已用完 — 升级套餐解锁"
              : `剩余 ${remaining!.toLocaleString()} ${unit}`}
        </span>
        {resetIn ? <span>{resetIn}</span> : null}
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
