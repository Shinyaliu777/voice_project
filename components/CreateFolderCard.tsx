"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FolderPlus, Loader2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Same palette as FolderCardMenu so existing + new folders look
// consistent. Keep in sync if either side adds colors.
const PALETTE: Array<{ label: string; value: string | null }> = [
  { label: "灰", value: null },
  { label: "红", value: "#ef4444" },
  { label: "橙", value: "#f97316" },
  { label: "黄", value: "#f59e0b" },
  { label: "绿", value: "#10b981" },
  { label: "蓝", value: "#3b82f6" },
  { label: "紫", value: "#8b5cf6" },
  { label: "粉", value: "#ec4899" },
];

/**
 * The dashed "+ 新建文件夹" tile rendered next to existing folder cards
 * on /dashboard/history. The history page used to render only the
 * existing folders + an "未归档" tile, with no way to create the first
 * folder anywhere in the app — SessionFolderPicker even tells users
 * "还没有文件夹，先去新建一个" but never said where to do that. This
 * card closes the loop.
 *
 * Submitting calls POST /api/folders, which the backend has supported
 * since day one; the missing piece was purely the UI entry point.
 */
export function CreateFolderCard() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const reset = () => {
    setName("");
    setColor(null);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("文件夹名称不能为空");
      return;
    }
    setSaving(true);
    try {
      const resp = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, color }),
      });
      if (resp.status === 409) {
        toast.error("已存在同名文件夹");
        return;
      }
      if (!resp.ok) {
        toast.error(`新建失败 (${resp.status})`);
        return;
      }
      toast.success("文件夹已创建");
      setOpen(false);
      reset();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "新建失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group flex items-start gap-3 rounded-[10px] border border-dashed border-zinc-200 bg-transparent p-4 text-left transition hover:border-zinc-300 hover:bg-zinc-50/60 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-900/40"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 group-hover:bg-zinc-200 group-hover:text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 dark:group-hover:bg-zinc-700 dark:group-hover:text-zinc-200">
          <FolderPlus className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-zinc-700 dark:text-zinc-200">
            新建文件夹
          </div>
          <div className="mt-0.5 text-xs text-zinc-500">
            把相关录音归到一起
          </div>
        </div>
      </button>

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
            <DialogDescription>
              给文件夹起个名字，可选一个颜色方便识别
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-folder-name">文件夹名称</Label>
              <Input
                id="new-folder-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：CS61A、英语听力、组会"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !saving) submit();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>颜色</Label>
              <div className="flex flex-wrap gap-2">
                {PALETTE.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    onClick={() => setColor(c.value)}
                    aria-pressed={color === c.value}
                    aria-label={`颜色 ${c.label}`}
                    className="flex h-8 w-8 items-center justify-center rounded-full border-2 transition"
                    style={{
                      borderColor:
                        color === c.value
                          ? c.value ?? "#71717a"
                          : "transparent",
                      backgroundColor: c.value ?? "#f4f4f5",
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              <span>创建</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default CreateFolderCard;
