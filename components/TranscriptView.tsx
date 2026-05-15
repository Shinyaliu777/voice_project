"use client";

import * as React from "react";
import { SegmentCard } from "@/components/SegmentCard";
import { cn } from "@/lib/utils";
import type { SegmentDTO, SpeakerNameDTO } from "@/lib/contracts";

export interface TranscriptViewProps {
  segments: SegmentDTO[];
  speakerNames?: SpeakerNameDTO[];
  onSeek?: (atMs: number) => void;
  onSegmentChanged?: (id: string, patch: Partial<SegmentDTO>) => void;
  onSegmentDeleted?: (id: string) => void;
  className?: string;
}

export function TranscriptView({
  segments,
  speakerNames,
  onSeek,
  onSegmentChanged,
  onSegmentDeleted,
  className,
}: TranscriptViewProps) {
  const nameMap = React.useMemo(() => {
    const out = new Map<number, string>();
    (speakerNames ?? []).forEach((n) => out.set(n.speakerId, n.name));
    return out;
  }, [speakerNames]);

  if (!segments || segments.length === 0) {
    return (
      <div
        className={cn(
          "rounded-lg border border-dashed border-zinc-200 px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400",
          className
        )}
      >
        还没有转录内容。
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {segments.map((segment) => (
        <SegmentCard
          key={segment.id}
          segment={segment}
          speakerName={
            segment.speakerId != null ? nameMap.get(segment.speakerId) : undefined
          }
          onSeek={onSeek}
          onChanged={(patch) => onSegmentChanged?.(segment.id, patch)}
          onDeleted={() => onSegmentDeleted?.(segment.id)}
        />
      ))}
    </div>
  );
}

export default TranscriptView;
