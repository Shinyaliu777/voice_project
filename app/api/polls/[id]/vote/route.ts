import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";

export const runtime = "nodejs";

const bodySchema = z.object({
  optionId: z.string().min(1),
});

interface PollVoteResponse {
  pollId: string;
  myVote: string;
  totalVotes: number;
  options: Array<{ id: string; label: string; votes: number }>;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id: pollId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { optionId } = parsed.data;

  // The sample polls live in-memory only; gracefully accept their vote so the
  // page can still show a result locally without writing to the DB.
  if (pollId.startsWith("sample-")) {
    return NextResponse.json({
      pollId,
      myVote: optionId,
      totalVotes: 0,
      options: [],
      sample: true,
    });
  }

  const option = await prisma.pollOption.findUnique({
    where: { id: optionId },
    select: { id: true, pollId: true },
  });
  if (!option || option.pollId !== pollId) {
    return NextResponse.json(
      { error: "Option does not belong to poll" },
      { status: 400 }
    );
  }

  // Upsert the vote and adjust option counts in a single transaction so the
  // displayed totals stay consistent if the user changes their pick.
  await prisma.$transaction(async (tx) => {
    const existing = await tx.pollVote.findUnique({
      where: { pollId_voterId: { pollId, voterId: userId } },
    });
    if (existing) {
      if (existing.optionId === optionId) return; // no-op
      // Decrement previous option, increment new one, then update the vote row.
      await tx.pollOption.update({
        where: { id: existing.optionId },
        data: { votes: { decrement: 1 } },
      });
      await tx.pollOption.update({
        where: { id: optionId },
        data: { votes: { increment: 1 } },
      });
      await tx.pollVote.update({
        where: { id: existing.id },
        data: { optionId },
      });
    } else {
      await tx.pollVote.create({
        data: { pollId, optionId, voterId: userId },
      });
      await tx.pollOption.update({
        where: { id: optionId },
        data: { votes: { increment: 1 } },
      });
    }
  });

  const options = await prisma.pollOption.findMany({
    where: { pollId },
    orderBy: { id: "asc" },
    select: { id: true, label: true, votes: true },
  });
  const totalVotes = options.reduce((sum, o) => sum + o.votes, 0);

  const resp: PollVoteResponse = {
    pollId,
    myVote: optionId,
    totalVotes,
    options,
  };
  return NextResponse.json(resp);
}
