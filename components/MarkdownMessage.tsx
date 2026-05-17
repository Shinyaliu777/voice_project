"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

interface MarkdownMessageProps {
  content: string;
  /**
   * Apply prose-friendly typography. Defaults to true. Set false when the
   * caller needs to control spacing manually (e.g. inline use).
   */
  withProse?: boolean;
  className?: string;
}

/**
 * Renders assistant chat content as Markdown using react-markdown + remark-gfm
 * (GitHub-flavored tables/strikethrough/task-lists).
 *
 * Safe by default: we do NOT enable rehype-raw, so any raw HTML in the model
 * output is rendered as text — preventing XSS via the model.
 */
export function MarkdownMessage({
  content,
  withProse = true,
  className,
}: MarkdownMessageProps) {
  return (
    <div
      className={cn(
        // Inherit the bubble's font/color; only style block-level Markdown.
        withProse &&
          "[&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 " +
            "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 " +
            "[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 " +
            "[&_li]:my-0.5 " +
            "[&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-base [&_h1]:font-semibold " +
            "[&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold " +
            "[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold " +
            "[&_strong]:font-semibold " +
            "[&_em]:italic " +
            "[&_a]:text-blue-600 [&_a]:underline hover:[&_a]:text-blue-700 " +
            "dark:[&_a]:text-blue-400 dark:hover:[&_a]:text-blue-300 " +
            "[&_code]:rounded [&_code]:bg-zinc-200/70 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em] " +
            "dark:[&_code]:bg-zinc-800 " +
            "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-zinc-900 [&_pre]:p-3 [&_pre]:text-zinc-100 [&_pre]:text-xs " +
            "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit " +
            "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-300 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-600 " +
            "dark:[&_blockquote]:border-zinc-700 dark:[&_blockquote]:text-zinc-400 " +
            "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs " +
            "[&_th]:border [&_th]:border-zinc-200 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold " +
            "[&_td]:border [&_td]:border-zinc-200 [&_td]:px-2 [&_td]:py-1 " +
            "dark:[&_th]:border-zinc-700 dark:[&_td]:border-zinc-700 " +
            "[&_hr]:my-3 [&_hr]:border-zinc-200 dark:[&_hr]:border-zinc-800",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // No rehype-raw — keep raw HTML escaped for safety.
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownMessage;
