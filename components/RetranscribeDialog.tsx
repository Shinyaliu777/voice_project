"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface RetranscribeDialogProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Estimated duration to deduct (in seconds). */
  estimatedDeductSeconds?: number;
}

export function RetranscribeDialog({
  sessionId,
  open,
  onOpenChange,
  estimatedDeductSeconds,
}: RetranscribeDialogProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  const start = async () => {
    setPending(true);
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/retranscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      toast.success("已开始重新转录");
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "重新转录失败";
      toast.error(msg);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4" />
            重新转录
          </DialogTitle>
          <DialogDescription>使用已上传的录音文件重新识别本次会议</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <section>
            <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
              适用场景
            </h4>
            <ul className="list-disc space-y-0.5 pl-5 text-zinc-700 dark:text-zinc-300">
              <li>原始识别结果不准确</li>
              <li>更换了源语言或目标语言</li>
              <li>加入了新的自定义词汇</li>
            </ul>
          </section>

          <section className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">将清除现有的转录与会议纪要</p>
              <p className="text-xs">此操作不可撤销，已编辑的内容将丢失。</p>
            </div>
          </section>

          {estimatedDeductSeconds != null ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              预计扣减时长：约 {Math.ceil(estimatedDeductSeconds / 60)} 分钟
            </p>
          ) : (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              预计扣减时长：根据录音长度计算
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            取消
          </Button>
          <Button onClick={start} disabled={pending}>
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            <span>开始重新转录</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RetranscribeDialog;
