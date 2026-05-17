"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Folder as FolderIcon, FolderInput, Inbox, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FolderChoice {
  id: string;
  name: string;
  color: string | null;
}

export interface SessionFolderPickerProps {
  sessionId: string;
  currentFolderId: string | null;
  folders: FolderChoice[];
  className?: string;
}

export function SessionFolderPicker({
  sessionId,
  currentFolderId,
  folders,
  className,
}: SessionFolderPickerProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  const current = currentFolderId
    ? folders.find((f) => f.id === currentFolderId) ?? null
    : null;
  const label = current?.name ?? "未归档";
  const dotColor = current?.color ?? "#a1a1aa";

  const move = async (folderId: string | null) => {
    if (pending) return;
    if ((currentFolderId ?? null) === folderId) return;
    setPending(true);
    try {
      const resp = await fetch(`/api/transcription/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId }),
      });
      if (!resp.ok) {
        toast.error(`移动失败 (${resp.status})`);
        return;
      }
      toast.success(folderId ? "已移动到文件夹" : "已移出文件夹");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "移动失败");
    } finally {
      setPending(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={cn("gap-2", className)} disabled={pending}>
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : current ? (
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: dotColor }}
              aria-hidden
            />
          ) : (
            <Inbox className="h-4 w-4" />
          )}
          <span className="max-w-[10rem] truncate">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); void move(null); }}>
          <Inbox className="h-4 w-4" />
          <span className="flex-1">未归档</span>
          {currentFolderId == null && <Check className="h-4 w-4 text-zinc-500" />}
        </DropdownMenuItem>
        {folders.length > 0 && <DropdownMenuSeparator />}
        {folders.map((f) => (
          <DropdownMenuItem
            key={f.id}
            onSelect={(e) => {
              e.preventDefault();
              void move(f.id);
            }}
          >
            <FolderIcon
              className="h-4 w-4"
              style={{ color: f.color ?? "#71717a" }}
            />
            <span className="flex-1 truncate">{f.name}</span>
            {currentFolderId === f.id && <Check className="h-4 w-4 text-zinc-500" />}
          </DropdownMenuItem>
        ))}
        {folders.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-zinc-500">
            还没有文件夹，先去新建一个
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default SessionFolderPicker;

// Re-export icon trigger style for callers that want a label-less variant.
export { FolderInput };
