import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocumentManager } from "@/components/DocumentManager";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";

function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const sec = Math.max(1, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月前`;
  const year = Math.floor(month / 12);
  return `${year} 年前`;
}

function statusLabel(status: string): { label: string; tone: string } {
  switch (status) {
    case "ready":
      return { label: "已完成", tone: "bg-emerald-50 text-emerald-700" };
    case "recording":
      return { label: "录音中", tone: "bg-rose-50 text-rose-700" };
    case "uploading":
      return { label: "上传中", tone: "bg-amber-50 text-amber-700" };
    case "error":
      return { label: "出错", tone: "bg-red-50 text-red-700" };
    default:
      return { label: "草稿", tone: "bg-zinc-100 text-zinc-700" };
  }
}

export default async function FolderPage({
  params,
}: {
  params: Promise<{ folderId: string }>;
}) {
  const { folderId } = await params;
  const userId = await getDevUserId();

  let folderName = "未归档";
  let folderColor: string | null = null;
  let isUnfiled = false;

  if (folderId === "unfiled") {
    isUnfiled = true;
  } else {
    const folder = await prisma.folder.findUnique({
      where: { id: folderId },
      select: { id: true, name: true, color: true, userId: true },
    });
    if (!folder || folder.userId !== userId) {
      notFound();
    }
    folderName = folder.name;
    folderColor = folder.color;
  }

  const sessions = await prisma.session.findMany({
    where: {
      userId,
      folderId: isUnfiled ? null : folderId,
    },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { segments: true } } },
  });

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-4">
        <Link
          href="/dashboard/history"
          className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700"
        >
          <ArrowLeft className="h-4 w-4" />
          返回历史记录
        </Link>
      </div>

      <header className="mb-6 flex items-center gap-3">
        {isUnfiled ? (
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500">
            <Inbox className="h-5 w-5" />
          </div>
        ) : (
          <span
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: folderColor ?? "#a1a1aa" }}
          />
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          {folderName}
        </h1>
        <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
          {sessions.length} 个录音
        </span>
      </header>

      {!isUnfiled ? <DocumentManager folderId={folderId} /> : null}

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled>
          选择
        </Button>
        <Button variant="outline" size="sm" disabled>
          合并
        </Button>
        <Button variant="outline" size="sm" disabled>
          全部状态
        </Button>
        <div className="ml-auto">
          <Button asChild size="sm">
            <Link href="/dashboard">新建录音</Link>
          </Button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center text-sm text-zinc-500">
          {isUnfiled
            ? "暂无未归档的录音"
            : "这个文件夹里还没有录音"}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
          <ul className="divide-y divide-zinc-100">
            {sessions.map((s) => {
              const status = statusLabel(s.status);
              return (
                <li key={s.id}>
                  <div className="flex items-center gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-zinc-900">
                          {s.title || "未命名录音"}
                        </span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${status.tone}`}
                        >
                          {status.label}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono">
                          {s.sourceLang.toUpperCase()} →{" "}
                          {s.targetLang.toUpperCase()}
                        </span>
                        <span>{s._count.segments} 段</span>
                        <span>{formatRelative(s.createdAt)}</span>
                      </div>
                    </div>
                    <Link
                      href={`/dashboard/history/${s.id}`}
                      className="shrink-0 text-sm text-zinc-600 hover:text-zinc-900"
                    >
                      查看 →
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
