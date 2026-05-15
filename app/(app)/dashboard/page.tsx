import Link from "next/link";
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
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          开始录音
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          实时转录、翻译，并生成 AI 会议纪要
        </p>
      </header>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <Recorder
          defaultSourceLang={initialSession?.sourceLang ?? "en"}
          defaultTargetLang={initialSession?.targetLang ?? "zh"}
          defaultTitle={initialSession?.title}
        />
      </section>

      <section className="mt-8 rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-6">
        <h2 className="text-base font-medium text-zinc-900">或上传音频文件</h2>
        <p className="mt-1 text-sm text-zinc-500">
          支持 mp3 / wav / m4a 等常见格式 (Phase 1 暂未启用功能)
        </p>
        <div className="mt-4 flex items-center gap-3">
          <label className="inline-flex cursor-not-allowed items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500">
            <input type="file" accept="audio/*" disabled className="hidden" />
            选择文件
          </label>
          <Link
            href="/dashboard?upload=true"
            className="text-sm text-zinc-500 hover:text-zinc-700"
          >
            了解更多
          </Link>
        </div>
      </section>
    </div>
  );
}
