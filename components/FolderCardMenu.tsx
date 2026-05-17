"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

interface FolderCardMenuProps {
  folder: {
    id: string;
    name: string;
    color: string | null;
  };
}

const PALETTE = [
  { label: "灰", value: null },
  { label: "红", value: "#ef4444" },
  { label: "橙", value: "#f97316" },
  { label: "黄", value: "#f59e0b" },
  { label: "绿", value: "#10b981" },
  { label: "蓝", value: "#3b82f6" },
  { label: "紫", value: "#8b5cf6" },
  { label: "粉", value: "#ec4899" },
];

export function FolderCardMenu({ folder }: FolderCardMenuProps) {
  const router = useRouter();
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [name, setName] = React.useState(folder.name);
  const [color, setColor] = React.useState<string | null>(folder.color);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const openEdit = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setName(folder.name);
    setColor(folder.color);
    setEditOpen(true);
  };

  const openDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDeleteOpen(true);
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("文件夹名称不能为空");
      return;
    }
    setSaving(true);
    try {
      const resp = await fetch(`/api/folders/${folder.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, color }),
      });
      if (resp.status === 409) {
        toast.error("已存在同名文件夹");
        return;
      }
      if (!resp.ok) {
        toast.error(`保存失败 (${resp.status})`);
        return;
      }
      toast.success("已保存");
      setEditOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      const resp = await fetch(`/api/folders/${folder.id}`, {
        method: "DELETE",
      });
      if (!resp.ok && resp.status !== 204) {
        toast.error(`删除失败 (${resp.status})`);
        return;
      }
      toast.success("已删除");
      setDeleteOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            aria-label="文件夹操作"
            className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setEditOpen(true); }}>
            <Pencil className="h-4 w-4" />
            <span>编辑文件夹</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => { e.preventDefault(); setDeleteOpen(true); }}
            className="text-rose-600"
          >
            <Trash2 className="h-4 w-4" />
            <span>删除文件夹</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent
          onClick={(e) => e.stopPropagation()}
          className="sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle>编辑文件夹</DialogTitle>
            <DialogDescription>修改文件夹的名称或颜色</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="folder-name">文件夹名称</Label>
              <Input
                id="folder-name"
                value={name}
                placeholder="请输入文件夹名称"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void save();
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>颜色</Label>
              <div className="flex flex-wrap gap-2">
                {PALETTE.map((p) => {
                  const active = color === p.value;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setColor(p.value)}
                      aria-label={`选择 ${p.label} 色`}
                      aria-pressed={active}
                      className={`flex h-7 w-7 items-center justify-center rounded-full border transition ${
                        active
                          ? "border-zinc-900 ring-2 ring-zinc-900/20 dark:border-zinc-50"
                          : "border-zinc-200 hover:scale-110"
                      }`}
                      style={{ backgroundColor: p.value ?? "#e4e4e7" }}
                    />
                  );
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={save} disabled={saving || !name.trim()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              <span>保存</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent
          onClick={(e) => e.stopPropagation()}
          className="sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle>删除文件夹</DialogTitle>
            <DialogDescription>
              确定删除文件夹「{folder.name}」？文件夹内的录音不会被删除（会自动移到"未归档"），但术语和文档会一并清除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              <span>确认删除</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default FolderCardMenu;
