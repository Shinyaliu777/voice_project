"use client";

import * as React from "react";
import { Check, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";

type Billing = "monthly" | "yearly";

interface Tier {
  id: "free" | "lite" | "pro" | "business";
  name: string;
  /** Localized one-line tagline */
  tagline: string;
  monthlyPrice: number;
  /** minutes/month — null = unlimited */
  minutes: number | null;
  features: string[];
  highlight?: boolean;
}

const TIERS: Tier[] = [
  {
    id: "free",
    name: "Free",
    tagline: "适合体验和轻度使用",
    monthlyPrice: 0,
    minutes: 120,
    features: [
      "每月 120 分钟",
      "实时转写 + 翻译",
      "AI 智能纪要（标准模型）",
      "云端历史记录 30 天",
    ],
  },
  {
    id: "lite",
    name: "Lite",
    tagline: "适合每周开会的学生",
    monthlyPrice: 9.99,
    minutes: 600,
    features: [
      "每月 600 分钟",
      "悬浮字幕窗",
      "词汇本 + 文件夹术语",
      "导出 Word / PDF",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "适合研究生和高频用户",
    monthlyPrice: 29.99,
    minutes: 3600,
    features: [
      "每月 3600 分钟",
      "全部 Lite 功能",
      "AI 纪要（高级模型）",
      "无限闪卡 + 间隔重复",
      "共享与协作",
    ],
    highlight: true,
  },
  {
    id: "business",
    name: "Business",
    tagline: "团队 / 商业场景",
    monthlyPrice: 59.99,
    minutes: null,
    features: [
      "无限分钟",
      "全部 Pro 功能",
      "团队工作区",
      "优先支持与 SLA",
      "API 访问（即将上线）",
    ],
  },
];

export interface UpgradeDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}

export function UpgradeDialog({
  open,
  onOpenChange,
  children,
}: UpgradeDialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange]
  );

  const [billing, setBilling] = React.useState<Billing>("monthly");

  const formatPrice = (tier: Tier): string => {
    if (tier.monthlyPrice === 0) return "$0";
    if (billing === "monthly") return `$${tier.monthlyPrice.toFixed(2)}`;
    // yearly: 50% off effective monthly
    const effectiveMonthly = tier.monthlyPrice * 0.5;
    return `$${effectiveMonthly.toFixed(2)}`;
  };

  const formatMinutes = (tier: Tier): string => {
    if (tier.minutes === null) return "无限分钟";
    return `${tier.minutes.toLocaleString()} 分钟 / 月`;
  };

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {children}
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-amber-500" />
            升级到更高套餐
          </DialogTitle>
          <DialogDescription>
            解锁更多录音时长、高级 AI 模型与团队协作能力
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-center pt-1">
          <Tabs
            value={billing}
            onValueChange={(v) => setBilling(v as Billing)}
            className="w-auto"
          >
            <TabsList>
              <TabsTrigger value="monthly">月付</TabsTrigger>
              <TabsTrigger value="yearly">年付（省 50%）</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="grid grid-cols-1 gap-3 pt-2 md:grid-cols-2 lg:grid-cols-4">
          {TIERS.map((tier) => (
            <div
              key={tier.id}
              className={cn(
                "relative flex flex-col rounded-xl border p-4",
                tier.highlight
                  ? "border-zinc-900 shadow-md dark:border-zinc-50"
                  : "border-zinc-200 dark:border-zinc-800"
              )}
            >
              {tier.highlight ? (
                <Badge
                  variant="default"
                  className="absolute -top-2 right-3 h-5 px-2 text-[10px]"
                >
                  推荐
                </Badge>
              ) : null}

              <div className="text-sm font-semibold">{tier.name}</div>
              <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                {tier.tagline}
              </div>

              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-2xl font-semibold tracking-tight">
                  {formatPrice(tier)}
                </span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  /月
                </span>
              </div>
              {billing === "yearly" && tier.monthlyPrice > 0 ? (
                <div className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">
                  年付折算，按年计费
                </div>
              ) : null}

              <div className="mt-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                {formatMinutes(tier)}
              </div>

              <ul className="mt-4 flex-1 space-y-1.5">
                {tier.features.map((f) => (
                  <li
                    key={f}
                    className="flex items-start gap-1.5 text-xs text-zinc-700 dark:text-zinc-300"
                  >
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <Button
                variant={tier.highlight ? "default" : "outline"}
                size="sm"
                className="mt-4 w-full"
                disabled={tier.id === "free"}
                onClick={() => {
                  if (tier.id === "free") return;
                  toast.info("支付集成即将上线");
                }}
              >
                {tier.id === "free" ? "当前方案" : "升级"}
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default UpgradeDialog;
