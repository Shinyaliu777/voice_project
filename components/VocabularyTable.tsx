"use client";

import * as React from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type {
  CreateFlashcardBody,
  ExtractedTermDTO,
} from "@/lib/contracts";

export interface VocabularyDocumentGroup {
  documentId: string;
  folderId: string;
  fileName: string;
  terms: ExtractedTermDTO[];
}

export interface VocabularyTableProps {
  initialGroups: VocabularyDocumentGroup[];
}

interface TermRowProps {
  term: ExtractedTermDTO;
  onUpdate: (next: ExtractedTermDTO) => void;
  onDelete: (id: string) => void;
}

function TermRow({ term, onUpdate, onDelete }: TermRowProps) {
  const [editing, setEditing] = React.useState(false);
  const [front, setFront] = React.useState(term.term);
  const [back, setBack] = React.useState(term.definition ?? "");
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [creatingCard, setCreatingCard] = React.useState(false);

  React.useEffect(() => {
    setFront(term.term);
    setBack(term.definition ?? "");
  }, [term.id, term.term, term.definition]);

  const cancelEdit = () => {
    setFront(term.term);
    setBack(term.definition ?? "");
    setEditing(false);
  };

  const saveEdit = async () => {
    const nextFront = front.trim();
    if (!nextFront) {
      toast.error("术语不能为空");
      return;
    }
    setSaving(true);
    try {
      const resp = await fetch(`/api/extracted-terms/${term.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          term: nextFront,
          definition: back.trim() ? back.trim() : null,
        }),
      });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      const updated = (await resp.json()) as ExtractedTermDTO;
      onUpdate(updated);
      setEditing(false);
      toast.success("已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const resp = await fetch(`/api/extracted-terms/${term.id}`, {
        method: "DELETE",
      });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      onDelete(term.id);
      toast.success("已删除");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
      setDeleting(false);
    }
  };

  const convertToFlashcard = async () => {
    setCreatingCard(true);
    try {
      const body: CreateFlashcardBody = {
        front: term.term,
        back: term.definition ?? "",
      };
      const resp = await fetch("/api/flashcards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      toast.success("已加入闪卡");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "转换失败");
    } finally {
      setCreatingCard(false);
    }
  };

  if (editing) {
    return (
      <li className="flex flex-col gap-2 rounded-md border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-950">
        <Input
          value={front}
          onChange={(e) => setFront(e.target.value)}
          placeholder="术语"
          autoFocus
          disabled={saving}
        />
        <Input
          value={back}
          onChange={(e) => setBack(e.target.value)}
          placeholder="释义"
          disabled={saving}
        />
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={cancelEdit}
            disabled={saving}
          >
            <X className="h-3.5 w-3.5" />
            <span>取消</span>
          </Button>
          <Button size="sm" onClick={saveEdit} disabled={saving}>
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            <span>保存</span>
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li
      className={cn(
        "group flex items-start gap-3 rounded-md border border-transparent px-3 py-2 transition hover:border-zinc-200 hover:bg-zinc-50 dark:hover:border-zinc-800 dark:hover:bg-zinc-900",
        deleting && "pointer-events-none opacity-50"
      )}
    >
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="min-w-0 flex-1 cursor-pointer text-left"
        aria-label="编辑生词"
      >
        <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {term.term}
        </div>
        <div className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
          {term.definition?.trim() ? term.definition : "（未填写释义）"}
        </div>
      </button>
      <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={convertToFlashcard}
          disabled={creatingCard}
          aria-label="转为闪卡"
          title="转为闪卡"
        >
          {creatingCard ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setEditing(true)}
          aria-label="编辑"
          title="编辑"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
          onClick={handleDelete}
          disabled={deleting}
          aria-label="删除"
          title="删除"
        >
          {deleting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </li>
  );
}

interface DocumentSectionProps {
  group: VocabularyDocumentGroup;
  onUpdateTerm: (documentId: string, term: ExtractedTermDTO) => void;
  onDeleteTerm: (documentId: string, termId: string) => void;
}

function DocumentSection({
  group,
  onUpdateTerm,
  onDeleteTerm,
}: DocumentSectionProps) {
  const [open, setOpen] = React.useState(true);

  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-t-lg px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
        )}
        <FileText className="h-4 w-4 shrink-0 text-zinc-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {group.fileName}
        </span>
        <span className="shrink-0 rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          {group.terms.length}
        </span>
      </button>
      {open && (
        <div className="border-t border-zinc-100 p-2 dark:border-zinc-800">
          {group.terms.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-zinc-500">
              暂无生词
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {group.terms.map((t) => (
                <TermRow
                  key={t.id}
                  term={t}
                  onUpdate={(next) => onUpdateTerm(group.documentId, next)}
                  onDelete={(id) => onDeleteTerm(group.documentId, id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export function VocabularyTable({ initialGroups }: VocabularyTableProps) {
  const [groups, setGroups] = React.useState(initialGroups);
  const [query, setQuery] = React.useState("");

  const updateTerm = React.useCallback(
    (documentId: string, next: ExtractedTermDTO) => {
      setGroups((prev) =>
        prev.map((g) =>
          g.documentId === documentId
            ? {
                ...g,
                terms: g.terms.map((t) => (t.id === next.id ? next : t)),
              }
            : g
        )
      );
    },
    []
  );

  const deleteTerm = React.useCallback(
    (documentId: string, termId: string) => {
      setGroups((prev) =>
        prev.map((g) =>
          g.documentId === documentId
            ? { ...g, terms: g.terms.filter((t) => t.id !== termId) }
            : g
        )
      );
    },
    []
  );

  const normalizedQuery = query.trim().toLowerCase();
  const filteredGroups = React.useMemo(() => {
    if (!normalizedQuery) return groups;
    return groups
      .map((g) => ({
        ...g,
        terms: g.terms.filter((t) => {
          const hayTerm = t.term.toLowerCase();
          const hayDef = (t.definition ?? "").toLowerCase();
          return (
            hayTerm.includes(normalizedQuery) ||
            hayDef.includes(normalizedQuery)
          );
        }),
      }))
      .filter((g) => g.terms.length > 0);
  }, [groups, normalizedQuery]);

  const totalTerms = groups.reduce((acc, g) => acc + g.terms.length, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索术语或释义"
            className="pl-9"
            aria-label="搜索词汇"
          />
        </div>
        <span className="shrink-0 text-xs text-zinc-500">
          共 {totalTerms} 个生词
        </span>
      </div>

      {filteredGroups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950">
          {normalizedQuery
            ? "没有匹配的生词"
            : "还没有提取到生词 — 在文件夹里上传课件后，点击「提取生词」"}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {filteredGroups.map((g) => (
            <DocumentSection
              key={g.documentId}
              group={g}
              onUpdateTerm={updateTerm}
              onDeleteTerm={deleteTerm}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default VocabularyTable;
