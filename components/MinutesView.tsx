import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { MinutesSection } from "@/lib/contracts";

export interface MinutesViewProps {
  sections?: MinutesSection[] | null;
  contentMd?: string | null;
  loading?: boolean;
  className?: string;
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

export function MinutesView({ sections, contentMd, loading, className }: MinutesViewProps) {
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
    return (
      <div className={cn("flex flex-col gap-3", className)}>
        {sections.map((section, idx) => {
          const range = formatRange(section.timeStartMs, section.timeEndMs);
          return (
            <Card key={`${section.title}-${idx}`}>
              <CardHeader>
                <CardTitle className="flex items-baseline justify-between gap-3">
                  <span>{section.title}</span>
                  {range ? (
                    <span className="font-mono text-xs font-normal tabular-nums text-zinc-500 dark:text-zinc-400">
                      {range}
                    </span>
                  ) : null}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
                  {section.points.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })}
      </div>
    );
  }

  if (contentMd) {
    return (
      <div className={cn("prose-sm max-w-none text-sm leading-relaxed", className)}>
        <MarkdownLite source={contentMd} />
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

// ------------------------------------------------------------------
// Tiny markdown parser (headings, bold, italic, lists, paragraphs)
// ------------------------------------------------------------------

interface MarkdownLiteProps {
  source: string;
}

function MarkdownLite({ source }: MarkdownLiteProps) {
  const blocks = React.useMemo(() => parseBlocks(source), [source]);
  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block, i) => renderBlock(block, i))}
    </div>
  );
}

type Block =
  | { type: "h1" | "h2" | "h3"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "p"; text: string };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === "") {
      i += 1;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^###\s+(.*)$/.exec(line))) {
      blocks.push({ type: "h3", text: m[1] });
      i += 1;
      continue;
    }
    if ((m = /^##\s+(.*)$/.exec(line))) {
      blocks.push({ type: "h2", text: m[1] });
      i += 1;
      continue;
    }
    if ((m = /^#\s+(.*)$/.exec(line))) {
      blocks.push({ type: "h1", text: m[1] });
      i += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    // paragraph: consume until blank line
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() !== "" && !/^[-*]\s+/.test(lines[i].trim()) && !/^#{1,3}\s+/.test(lines[i].trim())) {
      para.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: "p", text: para.join(" ") });
  }
  return blocks;
}

function renderBlock(block: Block, key: number): React.ReactNode {
  switch (block.type) {
    case "h1":
      return (
        <h1 key={key} className="text-xl font-semibold tracking-tight">
          {renderInline(block.text)}
        </h1>
      );
    case "h2":
      return (
        <h2 key={key} className="text-lg font-semibold tracking-tight">
          {renderInline(block.text)}
        </h2>
      );
    case "h3":
      return (
        <h3 key={key} className="text-base font-semibold tracking-tight">
          {renderInline(block.text)}
        </h3>
      );
    case "ul":
      return (
        <ul key={key} className="list-disc space-y-1 pl-5">
          {block.items.map((it, i) => (
            <li key={i}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    case "p":
    default:
      return (
        <p key={key} className="leading-relaxed">
          {renderInline(block.text)}
        </p>
      );
  }
}

function renderInline(text: string): React.ReactNode {
  // Split on **bold** and _italic_ tokens. Bold wins on overlap.
  const out: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*)|(_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = regex.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      out.push(<strong key={key++}>{m[1].slice(2, -2)}</strong>);
    } else if (m[2]) {
      out.push(<em key={key++}>{m[2].slice(1, -1)}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default MinutesView;
