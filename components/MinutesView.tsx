"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { MinutesSection } from "@/lib/contracts";

export interface MinutesViewProps {
  sections?: MinutesSection[] | null;
  contentMd?: string | null;
  loading?: boolean;
  className?: string;
  /**
   * If set, the LAST section is rendered as "pending" (dashed border, "进行中"
   * badge). Used during live recording to distinguish chapters that are still
   * being written from chapters the LLM has confirmed.
   */
  pendingLastSection?: boolean;
}

function formatRange(startMs?: number, endMs?: number): string | null {
  const format = (ms: number) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => n.toString().padStart(2, "0");
    if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  };
  if (startMs == null && endMs == null) return null;
  if (startMs != null && endMs != null) return `${format(startMs)} – ${format(endMs)}`;
  if (startMs != null) return format(startMs);
  return format(endMs!);
}

export function MinutesView({
  sections,
  contentMd,
  loading,
  className,
  pendingLastSection,
}: MinutesViewProps) {
  if (loading) {
    return (
      <div className={cn("flex flex-col gap-3", className)}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800"
          />
        ))}
      </div>
    );
  }

  if (sections && sections.length > 0) {
    const lastIdx = sections.length - 1;
    return (
      <div className={cn("flex flex-col gap-3", className)}>
        {sections.map((section, idx) => {
          const range = formatRange(section.timeStartMs, section.timeEndMs);
          const isPending = pendingLastSection === true && idx === lastIdx;
          return (
            <Card
              key={`${section.title}-${idx}`}
              className={cn(
                isPending &&
                  "border-dashed border-zinc-300 bg-zinc-50/40 dark:border-zinc-700 dark:bg-zinc-900/40"
              )}
            >
              <CardHeader>
                <CardTitle className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-2">
                    {section.title}
                    {isPending ? (
                      <span className="rounded-full bg-zinc-200 px-1.5 py-0.5 text-[10px] font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                        进行中
                      </span>
                    ) : null}
                  </span>
                  {range ? (
                    <span className="font-mono text-xs font-normal tabular-nums text-zinc-500 dark:text-zinc-400">
                      {range}
                    </span>
                  ) : null}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {section.narrative && section.narrative.trim() ? (
                  // New shape: render the narrative as paragraph(s). Split on
                  // double newlines so the LLM's paragraph breaks survive.
                  <div className="space-y-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-200">
                    {section.narrative
                      .trim()
                      .split(/\n{2,}/)
                      .filter((p) => p.trim().length > 0)
                      .map((p, i) => (
                        <p key={i} className="whitespace-pre-wrap">
                          {p.trim()}
                        </p>
                      ))}
                  </div>
                ) : section.points.length > 0 ? (
                  // Legacy fallback: pre-narrative rows persisted as bullets.
                  <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
                    {section.points.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    );
  }

  if (contentMd) {
    return (
      <div
        className={cn(
          "max-w-none text-sm leading-relaxed text-zinc-800 dark:text-zinc-200",
          className
        )}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ ...p }) => (
              <h1 className="mt-6 text-xl font-semibold tracking-tight" {...p} />
            ),
            h2: ({ ...p }) => (
              <h2 className="mt-5 text-lg font-semibold tracking-tight" {...p} />
            ),
            h3: ({ ...p }) => (
              <h3 className="mt-4 text-base font-semibold tracking-tight" {...p} />
            ),
            p: ({ ...p }) => <p className="my-2 leading-relaxed" {...p} />,
            ul: ({ ...p }) => (
              <ul className="my-2 list-disc space-y-1 pl-5" {...p} />
            ),
            ol: ({ ...p }) => (
              <ol className="my-2 list-decimal space-y-1 pl-5" {...p} />
            ),
            li: ({ ...p }) => <li className="leading-relaxed" {...p} />,
            blockquote: ({ ...p }) => (
              <blockquote
                className="my-3 border-l-2 border-zinc-300 pl-3 italic text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                {...p}
              />
            ),
            code: ({ className: codeClassName, children, ...p }) => {
              const inline = !codeClassName;
              if (inline) {
                return (
                  <code
                    className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-800"
                    {...p}
                  >
                    {children}
                  </code>
                );
              }
              return (
                <code
                  className="block overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-800"
                  {...p}
                >
                  {children}
                </code>
              );
            },
            table: ({ ...p }) => (
              <div className="my-3 overflow-x-auto">
                <table className="w-full border-collapse text-xs" {...p} />
              </div>
            ),
            th: ({ ...p }) => (
              <th
                className="border-b border-zinc-200 px-2 py-1 text-left font-semibold dark:border-zinc-800"
                {...p}
              />
            ),
            td: ({ ...p }) => (
              <td
                className="border-b border-zinc-100 px-2 py-1 dark:border-zinc-900"
                {...p}
              />
            ),
            a: ({ ...p }) => (
              <a
                className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400"
                target="_blank"
                rel="noreferrer"
                {...p}
              />
            ),
          }}
        >
          {contentMd}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-dashed border-zinc-200 px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400",
        className
      )}
    >
      还没有生成会议纪要。
    </div>
  );
}

export default MinutesView;
