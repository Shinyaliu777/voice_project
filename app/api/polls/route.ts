import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";

export const runtime = "nodejs";

const createBodySchema = z.object({
  question: z.string().min(1).max(500),
  description: z.string().max(2_000).optional(),
  options: z.array(z.string().min(1).max(200)).min(2).max(10),
});

interface PollOptionView {
  id: string;
  label: string;
  votes: number;
}

export interface PollView {
  id: string;
  question: string;
  description: string | null;
  options: PollOptionView[];
  totalVotes: number;
  myVote: string | null;
  createdAt: string;
}

const SAMPLE_POLLS: PollView[] = [
  {
    id: "sample-1",
    question: "下次会议你最想看到哪个功能？",
    description: "Phase 2 优先级排序，结果仅用于内部参考。",
    options: [
      { id: "opt-1-1", label: "实时分享 / 协作字幕", votes: 12 },
      { id: "opt-1-2", label: "更智能的会议纪要", votes: 8 },
      { id: "opt-1-3", label: "多语种同时翻译", votes: 5 },
      { id: "opt-1-4", label: "音频离线处理 / 上传文件", votes: 3 },
    ],
    totalVotes: 28,
    myVote: null,
    createdAt: new Date().toISOString(),
  },
  {
    id: "sample-2",
    question: "你最常用的源语言是？",
    description: "用于优化默认设置，匿名统计。",
    options: [
      { id: "opt-2-1", label: "中文", votes: 14 },
      { id: "opt-2-2", label: "英文", votes: 22 },
      { id: "opt-2-3", label: "日文", votes: 6 },
      { id: "opt-2-4", label: "其他", votes: 2 },
    ],
    totalVotes: 44,
    myVote: null,
    createdAt: new Date().toISOString(),
  },
];

export async function GET() {
  const userId = await getDevUserId();

  const polls = await prisma.poll.findMany({
    where: {
      OR: [{ userId }, { userId: "system" }],
    },
    include: {
      options: { orderBy: { id: "asc" } },
      votes: { where: { voterId: userId }, select: { optionId: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  if (polls.length === 0) {
    return NextResponse.json({ items: SAMPLE_POLLS });
  }

  const items: PollView[] = polls.map((p) => {
    const options: PollOptionView[] = p.options.map((o) => ({
      id: o.id,
      label: o.label,
      votes: o.votes,
    }));
    const totalVotes = options.reduce((sum, o) => sum + o.votes, 0);
    const myVote = p.votes[0]?.optionId ?? null;
    return {
      id: p.id,
      question: p.question,
      description: p.description ?? null,
      options,
      totalVotes,
      myVote,
      createdAt: p.createdAt.toISOString(),
    };
  });

  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const userId = await getDevUserId();

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = createBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { question, description, options } = parsed.data;

  const created = await prisma.poll.create({
    data: {
      userId,
      question,
      description: description ?? null,
      options: {
        create: options.map((label) => ({ label })),
      },
    },
    include: { options: { orderBy: { id: "asc" } } },
  });

  const view: PollView = {
    id: created.id,
    question: created.question,
    description: created.description ?? null,
    options: created.options.map((o) => ({
      id: o.id,
      label: o.label,
      votes: o.votes,
    })),
    totalVotes: 0,
    myVote: null,
    createdAt: created.createdAt.toISOString(),
  };
  return NextResponse.json(view, { status: 201 });
}
