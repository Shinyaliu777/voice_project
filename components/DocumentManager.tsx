"use client";

import * as React from "react";
import {
  CheckCircle2,
  FileText,
  Loader2,
  Sparkles,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type {
  DocumentDTO,
  DocumentConfirmBody,
  DocumentPresignBody,
  DocumentPresignResponse,
} from "@/lib/contracts";

interface DocumentManagerProps {
  folderId: string;
}

const MAX_SIZE_BYTES = 20 * 1024 * 1024;
const ACCEPTED_EXT = [".pdf", ".docx", ".txt", ".md"];
const ACCEPTED_EXT_SET = new Set(ACCEPTED_EXT);
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

const MIME_FALLBACK: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
};

interface UploadingItem {
  id: string; // ephemeral client id
  fileName: string;
  fileSize: number;
  progress: number; // 0-100
  state: "uploading" | "confirming" | "error";
  error?: string;
}

function getExt(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return "";
  return fileName.slice(dot).toLowerCase();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function resolveFileType(file: File): string {
  if (file.type && file.type.trim()) return file.type;
  const ext = getExt(file.name).replace(".", "");
  return MIME_FALLBACK[ext] ?? "application/octet-stream";
}

function statusBadge(status: DocumentDTO["extractionStatus"]) {
  switch (status) {
    case "done":
      return {
        label: "已提取",
        tone: "bg-emerald-50 text-emerald-700 border-emerald-200",
        icon: <CheckCircle2 className="h-3 w-3" />,
      };
    case "processing":
      return {
        label: "提取中",
        tone: "bg-amber-50 text-amber-700 border-amber-200",
        icon: <Loader2 className="h-3 w-3 animate-spin" />,
      };
    case "failed":
      return {
        label: "失败",
        tone: "bg-red-50 text-red-700 border-red-200",
        icon: <XCircle className="h-3 w-3" />,
      };
    default:
      return {
        label: "待处理",
        tone: "bg-zinc-100 text-zinc-600 border-zinc-200",
        icon: null,
      };
  }
}

function uploadFileXhr(
  url: string,
  file: File,
  contentType: string,
  extraHeaders: Record<string, string> | undefined,
  onProgress: (pct: number) => void,
  method: "PUT" | "POST" = "PUT"
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader("Content-Type", contentType);
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        // Browsers forbid setting some headers; skip Content-Type to avoid dupes
        if (k.toLowerCase() === "content-type") continue;
        try {
          xhr.setRequestHeader(k, v);
        } catch {
          // ignore
        }
      }
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(
          new Error(`Upload failed (${xhr.status}): ${xhr.responseText || xhr.statusText}`)
        );
      }
    };
    xhr.onerror = () => reject(new Error("Upload network error"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    xhr.send(file);
  });
}

export function DocumentManager({ folderId }: DocumentManagerProps) {
  const [docs, setDocs] = React.useState<DocumentDTO[]>([]);
  const [loadingList, setLoadingList] = React.useState(true);
  const [uploading, setUploading] = React.useState<UploadingItem[]>([]);
  const [dragActive, setDragActive] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<DocumentDTO | null>(
    null
  );
  const [deleting, setDeleting] = React.useState(false);
  const [extractingIds, setExtractingIds] = React.useState<Set<string>>(
    new Set()
  );
  const dragCounterRef = React.useRef(0);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const pollTimersRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  const fetchDocs = React.useCallback(async () => {
    try {
      const resp = await fetch(`/api/folders/${folderId}/documents`, {
        cache: "no-store",
      });
      if (!resp.ok) {
        throw new Error(`列表加载失败 (${resp.status})`);
      }
      const data: { items: DocumentDTO[] } = await resp.json();
      setDocs(data.items ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "列表加载失败");
    } finally {
      setLoadingList(false);
    }
  }, [folderId]);

  React.useEffect(() => {
    void fetchDocs();
  }, [fetchDocs]);

  React.useEffect(() => {
    const timers = pollTimersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const validateFile = React.useCallback(
    (file: File): string | null => {
      const ext = getExt(file.name);
      if (!ACCEPTED_EXT_SET.has(ext)) {
        return `不支持的文件类型: ${ext || file.name}`;
      }
      if (file.size > MAX_SIZE_BYTES) {
        return `文件 ${file.name} 超过 20 MB 限制`;
      }
      return null;
    },
    []
  );

  const uploadOne = React.useCallback(
    async (file: File) => {
      const tempId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const fileType = resolveFileType(file);
      setUploading((prev) => [
        ...prev,
        {
          id: tempId,
          fileName: file.name,
          fileSize: file.size,
          progress: 0,
          state: "uploading",
        },
      ]);

      try {
        // 1. Presign
        const presignBody: DocumentPresignBody = {
          folderId,
          fileName: file.name,
          fileType,
          fileSize: file.size,
        };
        const presignResp = await fetch(
          `/api/folders/${folderId}/documents`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(presignBody),
          }
        );
        if (!presignResp.ok) {
          throw new Error(
            `预签名失败 (${presignResp.status})`
          );
        }
        const presign: DocumentPresignResponse = await presignResp.json();

        // 2. PUT file bytes
        await uploadFileXhr(
          presign.uploadUrl,
          file,
          fileType,
          presign.headers,
          (pct) => {
            setUploading((prev) =>
              prev.map((u) =>
                u.id === tempId ? { ...u, progress: pct } : u
              )
            );
          },
          presign.method
        );

        // 3. Confirm
        setUploading((prev) =>
          prev.map((u) =>
            u.id === tempId ? { ...u, state: "confirming", progress: 100 } : u
          )
        );
        const confirmBody: DocumentConfirmBody = {
          folderId,
          documentId: presign.documentId,
          fileName: file.name,
          fileType,
          fileSize: file.size,
          blobUrl: presign.publicUrl,
          storageKey: presign.storageKey,
        };
        const confirmResp = await fetch(
          `/api/folders/${folderId}/documents/confirm`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(confirmBody),
          }
        );
        if (!confirmResp.ok) {
          throw new Error(`确认失败 (${confirmResp.status})`);
        }
        const created: DocumentDTO = await confirmResp.json();

        setDocs((prev) => [created, ...prev]);
        setUploading((prev) => prev.filter((u) => u.id !== tempId));
        toast.success(`已上传：${file.name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "上传失败";
        setUploading((prev) =>
          prev.map((u) =>
            u.id === tempId ? { ...u, state: "error", error: msg } : u
          )
        );
        toast.error(`${file.name}：${msg}`);
      }
    },
    [folderId]
  );

  const processFiles = React.useCallback(
    async (files: File[]) => {
      const valid: File[] = [];
      for (const file of files) {
        const err = validateFile(file);
        if (err) {
          toast.error(err);
          continue;
        }
        valid.push(file);
      }
      // Serial upload as per spec
      for (const file of valid) {
        await uploadOne(file);
      }
    },
    [uploadOne, validateFile]
  );

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const arr = Array.from(files);
    e.target.value = "";
    void processFiles(arr);
  };

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer.items?.length) {
      setDragActive(true);
    }
  };

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setDragActive(false);
    }
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setDragActive(false);
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    void processFiles(Array.from(files));
  };

  const openPicker = () => {
    fileInputRef.current?.click();
  };

  const pollDocStatus = React.useCallback(
    (docId: string) => {
      const timers = pollTimersRef.current;
      const start = Date.now();
      const tick = async () => {
        if (Date.now() - start > POLL_TIMEOUT_MS) {
          timers.delete(docId);
          setExtractingIds((prev) => {
            if (!prev.has(docId)) return prev;
            const next = new Set(prev);
            next.delete(docId);
            return next;
          });
          toast.error("提取超时，请稍后再试");
          return;
        }
        try {
          const resp = await fetch(
            `/api/folders/${folderId}/documents`,
            { cache: "no-store" }
          );
          if (resp.ok) {
            const data: { items: DocumentDTO[] } = await resp.json();
            setDocs(data.items ?? []);
            const updated = (data.items ?? []).find((d) => d.id === docId);
            if (updated) {
              if (updated.extractionStatus === "done") {
                timers.delete(docId);
                setExtractingIds((prev) => {
                  if (!prev.has(docId)) return prev;
                  const next = new Set(prev);
                  next.delete(docId);
                  return next;
                });
                toast.success(
                  `已提取 ${updated.termCount} 个术语：${updated.fileName}`
                );
                return;
              }
              if (updated.extractionStatus === "failed") {
                timers.delete(docId);
                setExtractingIds((prev) => {
                  if (!prev.has(docId)) return prev;
                  const next = new Set(prev);
                  next.delete(docId);
                  return next;
                });
                toast.error(`提取失败：${updated.fileName}`);
                return;
              }
            }
          }
        } catch {
          // ignore transient errors, keep polling
        }
        const t = setTimeout(tick, POLL_INTERVAL_MS);
        timers.set(docId, t);
      };
      const t = setTimeout(tick, POLL_INTERVAL_MS);
      timers.set(docId, t);
    },
    [folderId]
  );

  const handleExtract = async (doc: DocumentDTO) => {
    if (extractingIds.has(doc.id)) return;
    setExtractingIds((prev) => {
      const next = new Set(prev);
      next.add(doc.id);
      return next;
    });
    // Optimistic
    setDocs((prev) =>
      prev.map((d) =>
        d.id === doc.id ? { ...d, extractionStatus: "processing" } : d
      )
    );
    try {
      const resp = await fetch(
        `/api/folders/${folderId}/documents/${doc.id}/extract-terms`,
        { method: "POST" }
      );
      if (!resp.ok) {
        throw new Error(`提取请求失败 (${resp.status})`);
      }
      // Response may already be `done` (synchronous backend) — refresh once.
      await fetchDocs();
      // Check current state after refresh by fetching again
      const refreshResp = await fetch(
        `/api/folders/${folderId}/documents`,
        { cache: "no-store" }
      );
      if (refreshResp.ok) {
        const data: { items: DocumentDTO[] } = await refreshResp.json();
        const current = (data.items ?? []).find((d) => d.id === doc.id);
        if (current?.extractionStatus === "done") {
          setExtractingIds((prev) => {
            if (!prev.has(doc.id)) return prev;
            const next = new Set(prev);
            next.delete(doc.id);
            return next;
          });
          toast.success(
            `已提取 ${current.termCount} 个术语：${current.fileName}`
          );
          return;
        }
        if (current?.extractionStatus === "failed") {
          setExtractingIds((prev) => {
            if (!prev.has(doc.id)) return prev;
            const next = new Set(prev);
            next.delete(doc.id);
            return next;
          });
          toast.error(`提取失败：${current.fileName}`);
          return;
        }
      }
      // Otherwise poll
      pollDocStatus(doc.id);
    } catch (err) {
      setExtractingIds((prev) => {
        if (!prev.has(doc.id)) return prev;
        const next = new Set(prev);
        next.delete(doc.id);
        return next;
      });
      setDocs((prev) =>
        prev.map((d) =>
          d.id === doc.id ? { ...d, extractionStatus: "failed" } : d
        )
      );
      toast.error(err instanceof Error ? err.message : "提取失败");
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const resp = await fetch(
        `/api/folders/${folderId}/documents/${deleteTarget.id}`,
        { method: "DELETE" }
      );
      if (!resp.ok && resp.status !== 204) {
        throw new Error(`删除失败 (${resp.status})`);
      }
      setDocs((prev) => prev.filter((d) => d.id !== deleteTarget.id));
      toast.success(`已删除：${deleteTarget.fileName}`);
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        课件文档
      </h2>

      <div
        role="button"
        tabIndex={0}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPicker();
          }
        }}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-white px-6 py-8 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400",
          dragActive
            ? "border-zinc-900 bg-zinc-50"
            : "border-zinc-300 hover:border-zinc-400 hover:bg-zinc-50"
        )}
      >
        <Upload className="h-6 w-6 text-zinc-500" aria-hidden />
        <div className="text-zinc-700">拖拽课件到此 / 或点击选择</div>
        <div className="text-xs text-zinc-500">
          支持 PDF / DOCX / TXT / MD，单文件 ≤ 20 MB
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXT.join(",")}
          className="hidden"
          onChange={onInputChange}
        />
      </div>

      {uploading.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {uploading.map((u) => (
            <li
              key={u.id}
              className="rounded-lg border border-zinc-200 bg-white p-3"
            >
              <div className="flex items-center gap-3">
                <FileText className="h-4 w-4 shrink-0 text-zinc-500" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-zinc-900">
                      {u.fileName}
                    </span>
                    <span className="shrink-0 text-xs text-zinc-500">
                      {u.state === "error"
                        ? "失败"
                        : u.state === "confirming"
                          ? "确认中…"
                          : `${u.progress}%`}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        u.state === "error"
                          ? "bg-red-500"
                          : u.state === "confirming"
                            ? "bg-emerald-500"
                            : "bg-zinc-900"
                      )}
                      style={{
                        width: `${u.state === "confirming" ? 100 : u.progress}%`,
                      }}
                    />
                  </div>
                  {u.state === "error" && u.error ? (
                    <div className="mt-1 text-xs text-red-600">{u.error}</div>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4">
        {loadingList ? (
          <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500">
            <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
            加载中…
          </div>
        ) : docs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500">
            还没有上传任何课件
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <ul className="divide-y divide-zinc-100">
              {docs.map((d) => {
                const badge = statusBadge(d.extractionStatus);
                const isExtracting =
                  extractingIds.has(d.id) ||
                  d.extractionStatus === "processing";
                return (
                  <li
                    key={d.id}
                    className="flex items-center gap-4 px-4 py-3"
                  >
                    <FileText className="h-5 w-5 shrink-0 text-zinc-500" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-zinc-900">
                          {d.fileName}
                        </span>
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                            badge.tone
                          )}
                        >
                          {badge.icon}
                          {badge.label}
                        </span>
                        {d.extractionStatus === "done" && d.termCount > 0 ? (
                          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                            {d.termCount} 个术语
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 text-xs text-zinc-500">
                        {formatFileSize(d.fileSize)}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {d.extractionStatus !== "done" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleExtract(d)}
                          disabled={isExtracting}
                        >
                          {isExtracting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Sparkles className="h-4 w-4" />
                          )}
                          <span>提取术语</span>
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="删除文档"
                        onClick={() => setDeleteTarget(d)}
                      >
                        <Trash2 className="h-4 w-4 text-zinc-500" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除文档</DialogTitle>
            <DialogDescription>
              确定删除「{deleteTarget?.fileName}」？该文档以及它提取出的术语将被永久移除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              <span>确认删除</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default DocumentManager;
