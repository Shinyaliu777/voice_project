import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Inbox } from "lucide-react";
import { DocumentManager } from "@/components/DocumentManager";
import { FolderSessionsList } from "@/components/FolderSessionsList";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";

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

  const [sessions, folders] = await Promise.all([
    prisma.session.findMany({
      where: {
        userId,
        folderId: isUnfiled ? null : folderId,
      },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { segments: true } } },
    }),
    // All this user's folders — used by FolderSessionsList for the
    // "move selected to…" target picker.
    prisma.folder.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    }),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-3 py-6 sm:max-w-4xl sm:px-4 md:max-w-5xl md:px-6 md:py-8 lg:max-w-6xl lg:px-8 2xl:max-w-7xl">
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

      <FolderSessionsList
        sessions={sessions.map((s) => ({
          id: s.id,
          title: s.title,
          sourceLang: s.sourceLang,
          targetLang: s.targetLang,
          status: s.status,
          createdAt: s.createdAt.toISOString(),
          segmentCount: s._count.segments,
          durationMs: s.durationMs,
        }))}
        folders={folders}
        currentFolderId={isUnfiled ? null : folderId}
      />
    </div>
  );
}
