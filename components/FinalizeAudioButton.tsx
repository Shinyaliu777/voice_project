"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

interface FinalizeAudioButtonProps {
  sessionId: string;
}

/**
 * Recovery action for sessions where audio chunks made it to storage
 * but /api/audio/finalize never ran — usually because the user closed
 * the tab without clicking "结束录制". The finalize route now accepts
 * a missing totalDurationMs (computed server-side from
 * sum(AudioChunk.durationMs)) so this button doesn't need any
 * client-tracked clock state to work.
 *
 * On success, refresh the page so the AudioPlayer becomes visible.
 */
export function FinalizeAudioButton({ sessionId }: FinalizeAudioButtonProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  const handleClick = async () => {
    setPending(true);
    try {
      const resp = await fetch("/api/audio/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!resp.ok) {
        const detail =
          (await resp.json().catch(() => null)) as { error?: string } | null;
        toast.error(detail?.error ?? `完成上传失败 (${resp.status})`);
        return;
      }
      toast.success("音频已拼接完成");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "完成上传失败");
    } finally {
      setPending(false);
    }
  };

  return (
    <Button onClick={handleClick} disabled={pending} size="sm">
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Upload className="h-4 w-4" />
      )}
      <span>完成上传</span>
    </Button>
  );
}

export default FinalizeAudioButton;
