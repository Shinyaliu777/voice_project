import { Recorder } from "@/components/Recorder";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import type { SessionDTO } from "@/lib/contracts";

function toSessionDTO(s: {
  id: string;
  title: string;
  folderId: string | null;
  sourceLang: string;
  targetLang: string;
  status: string;
  durationMs: number | null;
  audioPath: string | null;
  audioContentType: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { segments: number };
}): SessionDTO {
  return {
    id: s.id,
    title: s.title,
    folderId: s.folderId,
    sourceLang: s.sourceLang,
    targetLang: s.targetLang,
    status: s.status as SessionDTO["status"],
    durationMs: s.durationMs,
    audioPath: s.audioPath,
    audioContentType: s.audioContentType,
    segmentCount: s._count?.segments ?? 0,
    hasMinutes: false,
    audioUrl: null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export default async function DashboardPage() {
  const userId = await getDevUserId();

  // Recent unfinished session (status not "ready" and not "error")
  const unfinished = await prisma.session.findFirst({
    where: {
      userId,
      status: { in: ["idle", "recording", "uploading"] },
    },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { segments: true } } },
  });

  const initialSession = unfinished ? toSessionDTO(unfinished) : undefined;

  return (
    <div className="mx-auto flex h-[calc(100vh-3rem)] max-w-5xl flex-col px-6 py-6">
      <Recorder
        defaultSourceLang={initialSession?.sourceLang ?? "en"}
        defaultTargetLang={initialSession?.targetLang ?? "zh"}
        defaultTitle={initialSession?.title}
      />
    </div>
  );
}
