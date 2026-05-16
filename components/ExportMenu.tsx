"use client";

import * as React from "react";
import { Download, FileAudio, FileText, FileType, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ExportMenuProps {
  sessionId: string;
  hasAudio?: boolean;
  className?: string;
}

type Format = "docx" | "pdf" | "audio";

export function ExportMenu({ sessionId, hasAudio = true, className }: ExportMenuProps) {
  const [busy, setBusy] = React.useState<Format | null>(null);

  const run = async (fmt: Format) => {
    if (busy) return;
    setBusy(fmt);
    try {
      const url = `/api/sessions/${sessionId}/export?format=${fmt}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        if (resp.status === 501) {
          const body = await resp.json().catch(() => ({}));
          toast(body?.error ?? "暂不支持");
        } else {
          toast.error(`导出失败 (${resp.status})`);
        }
        return;
      }
      const blob = await resp.blob();
      const disp = resp.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disp);
      const filename = match?.[1] ?? `session.${fmt === "audio" ? "webm" : fmt}`;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
      toast.success(`已导出 ${filename}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "导出失败");
    } finally {
      setBusy(null);
    }
  };

  const Item = ({
    fmt,
    icon,
    label,
    disabled,
  }: {
    fmt: Format;
    icon: React.ReactNode;
    label: string;
    disabled?: boolean;
  }) => (
    <DropdownMenuItem
      disabled={disabled || busy != null}
      onSelect={(e) => {
        e.preventDefault();
        void run(fmt);
      }}
    >
      {busy === fmt ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      <span>{label}</span>
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={className}>
          <Download className="h-4 w-4" />
          <span>导出</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <Item fmt="docx" icon={<FileType className="h-4 w-4" />} label="导出为 Word (.docx)" />
        <Item fmt="pdf" icon={<FileText className="h-4 w-4" />} label="导出为 PDF (.pdf)" />
        <Item
          fmt="audio"
          icon={<FileAudio className="h-4 w-4" />}
          label="导出音频"
          disabled={!hasAudio}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default ExportMenu;
