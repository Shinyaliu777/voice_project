import Link from "next/link";
import { Folder as FolderIcon, Inbox } from "lucide-react";
import { FolderCardMenu } from "@/components/FolderCardMenu";
import { CreateFolderCard } from "@/components/CreateFolderCard";
import { AppHeader } from "@/components/AppHeader";
import { SessionHistoryGrouped } from "@/components/SessionHistoryGrouped";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toSessionDTO } from "@/lib/api/dto";
import { audioFileUrl } from "@/lib/audio-url";

interface HistoryPageProps {
  searchParams: Promise<{ q?: string }>;
}

export default async function HistoryPage({ searchParams }: HistoryPageProps) {
  const { q: rawQ } = await searchParams;
  const query = (rawQ ?? "").trim();
  const userId = await getDevUserId();

  const [folders, unfiledCount, sessionRows] = await Promise.all([
    prisma.folder.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { sessions: true, documents: true } },
      },
    }),
    prisma.session.count({ where: { userId, folderId: null } }),
    // Fetch enough sessions to make the grouped view meaningful. The list is
    // bucketed/grouped client-side so a generous limit is fine here — Prisma
    // streams results lazily and 200 sessions is still a very small payload.
    prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        _count: { select: { segments: true } },
        minutes: { select: { id: true } },
      },
    }),
  ]);

  const sessions = sessionRows.map((row) =>
    toSessionDTO(row, {
      segmentCount: row._count.segments,
      hasMinutes: !!row.minutes,
      audioUrl: audioFileUrl(row.audioPath),
    })
  );

  return (
    <div className="mx-auto max-w-3xl px-3 py-6 sm:max-w-4xl sm:px-4 md:max-w-5xl md:px-6 md:py-8 lg:max-w-6xl lg:px-8 2xl:max-w-7xl">
      <AppHeader title="历史记录" subtitle="管理你的所有录音和文件夹" />

      <section className="mb-10">
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-zinc-500">
          文件夹
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <Link
            href="/dashboard/history/folder/unfiled"
            className="group flex items-start gap-3 rounded-[10px] border border-zinc-100 bg-white p-4 transition hover:border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              <Inbox className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">未归档</div>
              <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                {unfiledCount} 个录音
              </div>
            </div>
          </Link>

          <CreateFolderCard />

          {folders.map((folder) => (
            <div
              key={folder.id}
              className="group relative rounded-[10px] border border-zinc-100 bg-white transition hover:border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:hover:bg-zinc-800"
            >
              <Link
                href={`/dashboard/history/folder/${folder.id}`}
                className="flex items-start gap-3 p-4"
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
                <div className="min-w-0 flex-1 pr-8">
                  <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                    {folder.name}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    {folder._count.sessions} 个录音 ·{" "}
                    {folder._count.documents} 份文档
                  </div>
                </div>
              </Link>
              <FolderCardMenu
                folder={{ id: folder.id, name: folder.name, color: folder.color }}
              />
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-zinc-500">
          所有录音
        </h2>
        <SessionHistoryGrouped sessions={sessions} query={query} />
      </section>
    </div>
  );
}
