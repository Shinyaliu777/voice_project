import Link from "next/link";
import { Folder as FolderIcon, Inbox } from "lucide-react";
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

export default async function HistoryPage() {
  const userId = await getDevUserId();

  const [folders, unfiledCount, sessions] = await Promise.all([
    prisma.folder.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { sessions: true, documents: true } },
      },
    }),
    prisma.session.count({ where: { userId, folderId: null } }),
    prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { _count: { select: { segments: true } } },
    }),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          历史记录
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          管理你的所有录音和文件夹
        </p>
      </header>

      <section className="mb-10">
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-zinc-500">
          文件夹
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <Link
            href="/dashboard/history/folder/unfiled"
            className="group flex items-start gap-3 rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-300 hover:shadow-sm"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500">
              <Inbox className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-zinc-900">未归档</div>
              <div className="mt-0.5 text-xs text-zinc-500">
                {unfiledCount} 个录音
              </div>
            </div>
          </Link>

          {folders.map((folder) => (
            <Link
              key={folder.id}
              href={`/dashboard/history/folder/${folder.id}`}
              className="group flex items-start gap-3 rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-300 hover:shadow-sm"
            >
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                style={{
                  backgroundColor: folder.color
                    ? `${folder.color}1a`
                    : "#f4f4f5",
                  color: folder.color ?? "#71717a",
                }}
              >
                <FolderIcon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-zinc-900">
                  {folder.name}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {folder._count.sessions} 个录音 · {folder._count.documents}{" "}
                  份文档
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-zinc-500">
          最近录音
        </h2>
        {sessions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center text-sm text-zinc-500">
            还没有录音 — 从仪表板开始你的第一次会议
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <ul className="divide-y divide-zinc-100">
              {sessions.map((s) => {
                const status = statusLabel(s.status);
                return (
                  <li key={s.id}>
                    <Link
                      href={`/dashboard/history/${s.id}`}
                      className="flex items-center justify-between gap-4 px-4 py-3 transition hover:bg-zinc-50"
                    >
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
                      <span className="shrink-0 text-sm text-zinc-400">
                        查看 →
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
