import Link from "next/link";
import { BookOpen, Layers, Upload } from "lucide-react";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toExtractedTermDTO } from "@/lib/api/dto";
import { cn } from "@/lib/utils";
import {
  VocabularyTable,
  type VocabularyDocumentGroup,
} from "@/components/VocabularyTable";

export default async function VocabularyPage() {
  const userId = await getDevUserId();

  // Pull every document the dev user owns (via its folder) plus its terms.
  // Mirrors GET /api/extracted-terms — kept inline here so the initial render
  // ships with the data and avoids a client-side waterfall.
  const docs = await prisma.document.findMany({
    where: { folder: { userId } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      folderId: true,
      fileName: true,
      extractedTerms: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  const groups: VocabularyDocumentGroup[] = docs.map((d) => ({
    documentId: d.id,
    folderId: d.folderId,
    fileName: d.fileName,
    terms: d.extractedTerms.map(toExtractedTermDTO),
  }));

  const hasDocuments = groups.length > 0;

  return (
    <div className="mx-auto max-w-3xl px-3 py-6 sm:max-w-4xl sm:px-4 md:max-w-5xl md:px-6 md:py-8 lg:px-8">
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          词汇本
        </h1>
        <p className="mt-2 text-base text-zinc-500 dark:text-zinc-400">
          从课件里提取的术语，按需编辑或转为闪卡复习
        </p>
      </header>

      <VocabularyTabs />

      {!hasDocuments ? (
        <EmptyState />
      ) : (
        <VocabularyTable initialGroups={groups} />
      )}
    </div>
  );
}

function VocabularyTabs() {
  // Plain <Link> tabs — keeps server rendering and avoids client-side state
  // for what is just navigation between two routes.
  const tabClass =
    "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors";
  return (
    <nav
      className="mb-6 inline-flex h-10 items-center gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800"
      aria-label="词汇本导航"
    >
      <span
        className={cn(
          tabClass,
          "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100"
        )}
        aria-current="page"
      >
        <BookOpen className="h-4 w-4" />
        词汇
      </span>
      <Link
        href="/dashboard/vocabulary/flashcards"
        className={cn(
          tabClass,
          "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        )}
      >
        <Layers className="h-4 w-4" />
        闪卡
      </Link>
    </nav>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-12 text-center dark:border-zinc-700 dark:bg-zinc-950">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
        <Upload className="h-6 w-6 text-zinc-500" />
      </div>
      <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
        还没有课件
      </h2>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        上传课件后，可一键提取术语生成词汇本
      </p>
      <Link
        href="/dashboard/history"
        className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
      >
        去上传课件
        <span aria-hidden>→</span>
      </Link>
    </div>
  );
}
