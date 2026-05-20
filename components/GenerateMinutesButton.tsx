"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button, type ButtonProps } from "@/components/ui/button";
import type { MinutesDTO } from "@/lib/contracts";
import { track } from "@/lib/analytics";

export interface GenerateMinutesButtonProps
  extends Omit<ButtonProps, "onClick" | "children"> {
  sessionId: string;
  /** Optional callback once minutes are generated */
  onGenerated?: (minutes: MinutesDTO) => void;
  /** Label override */
  label?: string;
}

export function GenerateMinutesButton({
  sessionId,
  onGenerated,
  label = "生成纪要",
  variant = "default",
  size = "sm",
  ...rest
}: GenerateMinutesButtonProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  const generate = async () => {
    setPending(true);
    const startedAt = Date.now();
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/minutes/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      let minutes: MinutesDTO | null = null;
      try {
        minutes = (await resp.json()) as MinutesDTO;
      } catch {
        // Body may be streaming/empty — that's okay
      }
      toast.success("纪要已生成");
      track("minutes_generated", {
        sessionId,
        durationMs: Date.now() - startedAt,
      });
      if (minutes && onGenerated) {
        onGenerated(minutes);
      } else {
        router.refresh();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "生成失败";
      toast.error(msg);
      track("minutes_failed", {
        sessionId,
        durationMs: Date.now() - startedAt,
        errorName: err instanceof Error ? err.name : "unknown",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      onClick={generate}
      disabled={pending || rest.disabled}
      variant={variant}
      size={size}
      {...rest}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Sparkles className="h-4 w-4" />
      )}
      <span>{label}</span>
    </Button>
  );
}

export default GenerateMinutesButton;
