import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Bookmark as BookmarkIcon, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AudioPlayer } from "@/components/AudioPlayer";
import { TranscriptView } from "@/components/TranscriptView";
import { MinutesView } from "@/components/MinutesView";
import { GenerateMinutesButton } from "@/components/GenerateMinutesButton";
import { ShareDialog } from "@/components/ShareDialog";
import { ExportMenu } from "@/components/ExportMenu";
import { SessionActionsBar } from "@/components/SessionActionsBar";
import { SessionFolderPicker } from "@/components/SessionFolderPicker";
import { RecommendCardsDialog } from "@/components/RecommendCardsDialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { getStorageProvider } from "@/lib/storage";
import type {
  BookmarkDTO,
  MinutesSection,
  SegmentDTO,
  SpeakerNameDTO,
} from "@/lib/contracts";

function statusLabel(status: string): { label: string; dot: string } {
  switch (status) {
    case "ready":
      return { label: "已完成", dot: "bg-emerald-500" };
    case "recording":
      return { label: "录音中", dot: "bg-rose-500" };
    case "uploading":
      return { label: "上传中", dot: "bg-amber-500" };
    case "error":
      return { label: "出错", dot: "bg-red-500" };
    default:
      return { label: "草稿", dot: "bg-zinc-400" };
  }
}

function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s
      .toString()
      .padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const userId = await getDevUserId();

  const [session, folders] = await Promise.all([
    prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        segments: { orderBy: { segmentIndex: "asc" } },
        speakerNames: true,
        bookmarks: { orderBy: { atMs: "asc" } },
        minutes: true,
      },
    }),
    prisma.folder.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    }),
  ]);

  if (!session || session.userId !== userId) {
    notFound();
  }

  const status = statusLabel(session.status);

  const segments: SegmentDTO[] = session.segments.map((s) => ({
    id: s.id,
    sessionId: s.sessionId,
    segmentIndex: s.segmentIndex,
    audioStartMs: s.audioStartMs,
    audioEndMs: s.audioEndMs,
    speakerId: s.speakerId,
    sourceText: s.sourceText,
    translatedText: s.translatedText,
    confidence: s.confidence,
    isFinal: s.isFinal,
  }));

  const speakerNames: SpeakerNameDTO[] = session.speakerNames.map((sn) => ({
    sessionId: sn.sessionId,
    speakerId: sn.speakerId,
    name: sn.name,
  }));

  const bookmarks: BookmarkDTO[] = session.bookmarks.map((b) => ({
    id: b.id,
    sessionId: b.sessionId,
    atMs: b.atMs,
    note: b.note,
    createdAt: b.createdAt.toISOString(),
  }));

  let audioUrl: string | null = null;
  if (session.audioPath) {
    try {
      audioUrl = getStorageProvider().publicUrlFor(session.audioPath);
    } catch {
      audioUrl = null;
    }
  }

  // Final (post-recording) minutes — written by the explicit "生成纪要"
  // button. Higher-quality, full-pass over the entire transcript.
  const minutesSections =
    (session.minutes?.sectionsJson as MinutesSection[] | null) ?? null;
  const rawContentMd = session.minutes?.contentMd ?? "";
  const minutesContentMd = rawContentMd.trim().length > 0 ? rawContentMd : null;

  // Live (incremental) minutes — written during recording by the
  // every-2000-char auto-refresh. Captures the running narrative as
  // it happened. Independent storage from the final fields above so
  // the two tabs render different content.
  const liveMinutesSections =
    (session.minutes?.liveSectionsJson as MinutesSection[] | null) ?? null;
  const rawLiveContentMd = session.minutes?.liveContentMd ?? "";
  const liveMinutesContentMd =
    rawLiveContentMd.trim().length > 0 ? rawLiveContentMd : null;

  return (
    <div className="mx-auto max-w-3xl px-3 py-6 sm:max-w-4xl sm:px-4 md:max-w-5xl md:px-6 md:py-8 lg:max-w-6xl lg:px-8 lg:py-10 2xl:max-w-7xl">
      <div className="mb-6">
        <Link
          href="/dashboard/history"
          className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700"
        >
          <ArrowLeft className="h-4 w-4" />
          返回历史记录
        </Link>
      </div>

      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900">
            {session.title || "未命名录音"}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${status.dot}`}
                aria-hidden
              />
              <span>{status.label}</span>
            </span>
            <span className="font-mono">
              {session.sourceLang.toUpperCase()} →{" "}
              {session.targetLang.toUpperCase()}
            </span>
            <span>时长 {formatDuration(session.durationMs)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <SessionFolderPicker
            sessionId={session.id}
            currentFolderId={session.folderId}
            folders={folders}
          />
          <SessionActionsBar
            sessionId={session.id}
            audioUrl={audioUrl}
            title={session.title || "未命名录音"}
          />
          <Button variant="outline" size="sm" asChild>
            <Link href={`/dashboard/chat/new?sessionId=${session.id}`}>
              <MessageSquare className="h-4 w-4" />
              <span>问问这段录音</span>
            </Link>
          </Button>
          <RecommendCardsDialog sessionId={session.id} />
          <ShareDialog sessionId={session.id} title={session.title} />
          <ExportMenu sessionId={session.id} />
        </div>
      </header>

      {bookmarks.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span className="inline-flex items-center gap-1 text-zinc-600">
            <BookmarkIcon className="h-3.5 w-3.5" aria-hidden />
            <span>{bookmarks.length} 个书签</span>
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {bookmarks.slice(0, 12).map((b) => (
              <a
                key={b.id}
                href={`#bookmark-${b.id}`}
                title={b.note ?? formatMs(b.atMs)}
                className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[11px] tabular-nums text-zinc-700 transition hover:bg-zinc-200"
              >
                {formatMs(b.atMs)}
              </a>
            ))}
          </div>
        </div>
      ) : null}

      {audioUrl ? (
        <div className="mb-8 rounded-[10px] bg-zinc-50 p-4 dark:bg-zinc-900/40">
          <AudioPlayer src={audioUrl} bookmarks={bookmarks} />
        </div>
      ) : (
        <div className="mb-8 rounded-[10px] border border-dashed border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          暂无音频文件 — 录音可能仍在上传中
        </div>
      )}

      <Tabs defaultValue="transcript" className="w-full">
        <TabsList>
          <TabsTrigger value="transcript">转录</TabsTrigger>
          {/* Two distinct minutes paths, two tabs, two persisted blobs
              (Minutes.liveContentMd vs Minutes.contentMd). 实时纪要 is
              what got written during the recording itself by the
              every-2000-char auto-refresh; 纪要 is what the user
              explicitly generated afterwards via "生成纪要", which
              does a full-pass over the whole transcript and is
              usually richer / better-structured. */}
          <TabsTrigger value="live-minutes">实时纪要</TabsTrigger>
          <TabsTrigger value="minutes">纪要</TabsTrigger>
        </TabsList>

        <TabsContent value="transcript">
          {segments.length === 0 ? (
            <div className="rounded-[10px] border border-zinc-100 bg-white p-10 text-center text-sm text-zinc-500 dark:border-zinc-900 dark:bg-zinc-950">
              还没有转录内容
            </div>
          ) : (
            <div className="rounded-[10px] border border-zinc-100 bg-white p-4 dark:border-zinc-900 dark:bg-zinc-950">
              <TranscriptView
                segments={segments}
                speakerNames={speakerNames}
              />
            </div>
          )}
        </TabsContent>

        <TabsContent value="live-minutes">
          {liveMinutesSections && liveMinutesSections.length > 0 ? (
            <div className="rounded-[10px] border border-zinc-100 bg-white p-6 dark:border-zinc-900 dark:bg-zinc-950">
              <MinutesView
                sections={liveMinutesSections}
                contentMd={liveMinutesContentMd}
              />
            </div>
          ) : liveMinutesContentMd ? (
            <div className="rounded-[10px] border border-zinc-100 bg-white p-6 dark:border-zinc-900 dark:bg-zinc-950">
              <MinutesView contentMd={liveMinutesContentMd} />
            </div>
          ) : (
            <div className="rounded-[10px] border border-zinc-100 bg-white p-10 text-center text-sm text-zinc-500 dark:border-zinc-900 dark:bg-zinc-950">
              录音过程中会自动生成 — 还没有内容
            </div>
          )}
        </TabsContent>

        <TabsContent value="minutes">
          {minutesSections && minutesSections.length > 0 ? (
            <div className="rounded-[10px] border border-zinc-100 bg-white p-6 dark:border-zinc-900 dark:bg-zinc-950">
              <MinutesView
                sections={minutesSections}
                contentMd={minutesContentMd}
              />
            </div>
          ) : minutesContentMd ? (
            <div className="rounded-[10px] border border-zinc-100 bg-white p-6 dark:border-zinc-900 dark:bg-zinc-950">
              <MinutesView contentMd={minutesContentMd} />
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 rounded-[10px] border border-zinc-100 bg-white p-10 text-center dark:border-zinc-900 dark:bg-zinc-950">
              <p className="text-sm text-zinc-500">
                还没有生成会议纪要 — 点击下方按钮基于完整转录重新生成
              </p>
              <GenerateMinutesButton sessionId={session.id} />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
