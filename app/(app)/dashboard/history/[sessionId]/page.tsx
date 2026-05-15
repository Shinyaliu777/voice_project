import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AudioPlayer } from "@/components/AudioPlayer";
import { TranscriptView } from "@/components/TranscriptView";
import { MinutesView } from "@/components/MinutesView";
import { GenerateMinutesButton } from "@/components/GenerateMinutesButton";
import { ShareDialog } from "@/components/ShareDialog";
import { ExportMenu } from "@/components/ExportMenu";
import { SessionActionsBar } from "@/components/SessionActionsBar";
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

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const userId = await getDevUserId();

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      segments: { orderBy: { segmentIndex: "asc" } },
      speakerNames: true,
      bookmarks: { orderBy: { atMs: "asc" } },
      minutes: true,
    },
  });

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

  const minutesSections =
    (session.minutes?.sectionsJson as MinutesSection[] | null) ?? null;
  const rawContentMd = session.minutes?.contentMd ?? "";
  const minutesContentMd = rawContentMd.trim().length > 0 ? rawContentMd : null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-4 flex items-center justify-between">
        <Link
          href="/dashboard/history"
          className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700"
        >
          <ArrowLeft className="h-4 w-4" />
          返回历史记录
        </Link>
      </div>

      <header className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          {session.title || "未命名录音"}
        </h1>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.tone}`}
        >
          {status.label}
        </span>
        <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-mono text-zinc-600">
          {session.sourceLang.toUpperCase()} →{" "}
          {session.targetLang.toUpperCase()}
        </span>
        <span className="text-sm text-zinc-500">
          时长 {formatDuration(session.durationMs)}
        </span>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <SessionActionsBar
          sessionId={session.id}
          audioUrl={audioUrl}
          title={session.title || "未命名录音"}
        />
        <ShareDialog sessionId={session.id} title={session.title} />
        <ExportMenu sessionId={session.id} />
      </div>

      {audioUrl ? (
        <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-4">
          <AudioPlayer src={audioUrl} bookmarks={bookmarks} />
        </div>
      ) : (
        <div className="mb-6 rounded-xl border border-dashed border-zinc-300 bg-white p-6 text-center text-sm text-zinc-500">
          暂无音频文件 — 录音可能仍在上传中
        </div>
      )}

      <Tabs defaultValue="transcript" className="w-full">
        <TabsList>
          <TabsTrigger value="transcript">转录</TabsTrigger>
          <TabsTrigger value="live-minutes">实时纪要</TabsTrigger>
          <TabsTrigger value="minutes">纪要</TabsTrigger>
        </TabsList>

        <TabsContent value="transcript">
          {segments.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center text-sm text-zinc-500">
              还没有转录内容
            </div>
          ) : (
            <TranscriptView
              segments={segments}
              speakerNames={speakerNames}
            />
          )}
        </TabsContent>

        <TabsContent value="live-minutes">
          {minutesSections && minutesSections.length > 0 ? (
            <MinutesView sections={minutesSections} />
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center text-sm text-zinc-500">
              尚未生成 — 切换到下一个 tab 触发生成
            </div>
          )}
        </TabsContent>

        <TabsContent value="minutes">
          {minutesContentMd ? (
            <MinutesView contentMd={minutesContentMd} />
          ) : (
            <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center">
              <p className="text-sm text-zinc-500">
                还没有生成会议纪要
              </p>
              <GenerateMinutesButton sessionId={session.id} />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
