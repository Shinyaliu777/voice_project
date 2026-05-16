import Link from "next/link";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";

interface SearchPageProps {
  searchParams: Promise<{ q?: string }>;
}

function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const re = new RegExp(`(${escapeRe(q)})`, "ig");
  const parts = text.split(re);
  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase() ? (
      <mark key={i} className="bg-yellow-200 px-0.5 dark:bg-yellow-700/50">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const { q: rawQ } = await searchParams;
  const q = (rawQ ?? "").trim();
  const userId = await getDevUserId();

  if (!q) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">搜索</h1>
        <p className="mt-2 text-sm text-zinc-500">在顶部输入关键词，搜索录音标题和转录片段。</p>
      </div>
    );
  }

  const [titleHits, segmentHits] = await Promise.all([
    prisma.session.findMany({
      where: { userId, title: { contains: q, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { _count: { select: { segments: true } } },
    }),
    prisma.segment.findMany({
      where: {
        session: { userId },
        OR: [
          { sourceText: { contains: q, mode: "insensitive" } },
          { translatedText: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: { session: { select: { id: true, title: true } } },
    }),
  ]);

  const total = titleHits.length + segmentHits.length;

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          搜索结果：<span className="font-mono">{q}</span>
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          匹配 {total} 条（{titleHits.length} 个会话，{segmentHits.length} 段转录）
        </p>
      </header>

      {total === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500">
          没有匹配的结果
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {titleHits.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
                会话标题
              </h2>
              <ul className="flex flex-col gap-2">
                {titleHits.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={`/dashboard/history/${s.id}`}
                      className="block rounded-lg border border-zinc-200 bg-white p-3 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                    >
                      <div className="font-medium">
                        {highlight(s.title || "未命名录音", q)}
                      </div>
                      <div className="mt-1 text-xs text-zinc-500">
                        {s.sourceLang.toUpperCase()} → {s.targetLang.toUpperCase()} ·{" "}
                        {s._count.segments} 个片段 · {new Date(s.createdAt).toLocaleString()}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {segmentHits.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
                转录片段
              </h2>
              <ul className="flex flex-col gap-2">
                {segmentHits.map((seg) => (
                  <li key={seg.id}>
                    <Link
                      href={`/dashboard/history/${seg.session.id}#segment-${seg.id}`}
                      className="block rounded-lg border border-zinc-200 bg-white p-3 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                    >
                      <div className="flex items-center gap-2 text-xs text-zinc-500">
                        <span className="font-medium text-zinc-700 dark:text-zinc-300">
                          {seg.session.title || "未命名录音"}
                        </span>
                        <span>·</span>
                        <span className="font-mono">{formatTime(seg.audioStartMs)}</span>
                      </div>
                      <p className="mt-1 text-sm leading-relaxed">
                        {highlight(seg.sourceText, q)}
                      </p>
                      {seg.translatedText ? (
                        <p className="mt-1 text-sm italic leading-relaxed text-zinc-600 dark:text-zinc-400">
                          {highlight(seg.translatedText, q)}
                        </p>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
