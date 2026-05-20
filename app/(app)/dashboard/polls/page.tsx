"use client";

import * as React from "react";
import { CheckCircle2, Loader2, Vote } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface PollOption {
  id: string;
  label: string;
  votes: number;
}

interface PollItem {
  id: string;
  question: string;
  description: string | null;
  options: PollOption[];
  totalVotes: number;
  myVote: string | null;
  createdAt: string;
}

interface PollListResponse {
  items: PollItem[];
}

interface VoteResponse {
  pollId: string;
  myVote: string;
  totalVotes: number;
  options: Array<{ id: string; label: string; votes: number }>;
  sample?: boolean;
}

export default function PollsPage() {
  const [polls, setPolls] = React.useState<PollItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/polls", { cache: "no-store" });
        if (!resp.ok) throw new Error(`load failed (${resp.status})`);
        const data = (await resp.json()) as PollListResponse;
        if (!cancelled) {
          setPolls(data.items);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "加载失败";
          setError(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const updatePollAfterVote = (
    pollId: string,
    optionId: string,
    serverResp: VoteResponse | null
  ) => {
    setPolls((prev) =>
      prev.map((p) => {
        if (p.id !== pollId) return p;
        // If the server returned authoritative counts, prefer them.
        if (serverResp && serverResp.options.length > 0) {
          return {
            ...p,
            myVote: serverResp.myVote,
            totalVotes: serverResp.totalVotes,
            options: serverResp.options,
          };
        }
        // Otherwise optimistically adjust for sample polls (no DB write).
        const prevVote = p.myVote;
        const options = p.options.map((o) => {
          let votes = o.votes;
          if (prevVote && prevVote === o.id) votes = Math.max(0, votes - 1);
          if (o.id === optionId) votes += 1;
          return { ...o, votes };
        });
        const totalVotes = options.reduce((sum, o) => sum + o.votes, 0);
        return { ...p, myVote: optionId, totalVotes, options };
      })
    );
  };

  const submitVote = async (pollId: string, optionId: string) => {
    try {
      const resp = await fetch(
        `/api/polls/${encodeURIComponent(pollId)}/vote`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ optionId }),
        }
      );
      if (!resp.ok) throw new Error(`vote failed (${resp.status})`);
      const data = (await resp.json()) as VoteResponse;
      updatePollAfterVote(pollId, optionId, data);
      toast.success("投票已记录");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "投票失败";
      toast.error(msg);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-full flex-col items-center justify-center px-3 py-10 text-center sm:max-w-3xl sm:px-4 md:px-6 md:py-12 lg:px-8">
        <Loader2 className="mb-4 h-6 w-6 animate-spin text-zinc-400" />
        <p className="text-sm text-zinc-500">加载投票中…</p>
      </div>
    );
  }

  if (error && polls.length === 0) {
    return (
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-full flex-col items-center justify-center px-3 py-10 text-center sm:max-w-3xl sm:px-4 md:px-6 md:py-12 lg:px-8">
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-zinc-100 text-zinc-400">
          <Vote className="h-7 w-7" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">投票</h1>
        <p className="mt-3 max-w-md text-sm text-zinc-500">无法加载投票：{error}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-full flex-col gap-6 px-3 py-6 sm:max-w-3xl sm:px-4 md:px-6 md:py-8 lg:px-8 lg:py-10">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
          <Vote className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            投票
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            选择你的偏好，结果会影响后续功能优先级。
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-4">
        {polls.map((poll) => (
          <PollCard key={poll.id} poll={poll} onVote={submitVote} />
        ))}
      </div>
    </div>
  );
}

interface PollCardProps {
  poll: PollItem;
  onVote: (pollId: string, optionId: string) => Promise<void>;
}

function PollCard({ poll, onVote }: PollCardProps) {
  const [selected, setSelected] = React.useState<string | null>(poll.myVote);
  const [submitting, setSubmitting] = React.useState(false);
  const hasVoted = !!poll.myVote;

  const onSubmit = async () => {
    if (!selected) {
      toast.error("请选择一个选项");
      return;
    }
    setSubmitting(true);
    try {
      await onVote(poll.id, selected);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="space-y-1.5">
        <CardTitle className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
          {poll.question}
        </CardTitle>
        {poll.description ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{poll.description}</p>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <fieldset
          className="flex flex-col gap-2"
          aria-label={poll.question}
          disabled={submitting}
        >
          {poll.options.map((opt) => {
            const isSelected = selected === opt.id;
            const isMyVote = poll.myVote === opt.id;
            const pct = poll.totalVotes > 0
              ? Math.round((opt.votes / poll.totalVotes) * 100)
              : 0;
            return (
              <label
                key={opt.id}
                className={cn(
                  "relative flex cursor-pointer flex-col gap-1.5 rounded-md border px-3 py-2.5 transition-colors",
                  isSelected
                    ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900"
                    : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                )}
              >
                <div className="flex items-center gap-2.5 text-sm">
                  <input
                    type="radio"
                    name={`poll-${poll.id}`}
                    value={opt.id}
                    checked={isSelected}
                    onChange={() => setSelected(opt.id)}
                    className="h-4 w-4 accent-zinc-900 dark:accent-zinc-100"
                  />
                  <span className="flex-1 text-zinc-900 dark:text-zinc-100">
                    {opt.label}
                  </span>
                  {isMyVote ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-label="你的投票" />
                  ) : null}
                  {hasVoted ? (
                    <span className="text-xs font-mono tabular-nums text-zinc-500">
                      {pct}%
                    </span>
                  ) : null}
                </div>
                {hasVoted ? (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                    <div
                      className={cn(
                        "h-full rounded-full transition-[width]",
                        isMyVote ? "bg-emerald-500" : "bg-zinc-400"
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                ) : null}
              </label>
            );
          })}
        </fieldset>

        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-xs text-zinc-500">
            {poll.totalVotes > 0
              ? `共 ${poll.totalVotes} 票`
              : "还没有投票"}
          </span>
          <Button
            size="sm"
            onClick={onSubmit}
            disabled={!selected || submitting || selected === poll.myVote}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            <span>{hasVoted ? "更新投票" : "确认投票"}</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
