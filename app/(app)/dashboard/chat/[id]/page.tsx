import { redirect } from "next/navigation";

import { ChatPanel } from "@/components/ChatPanel";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toChatMessageDTO, toChatSessionDTO } from "@/lib/api/dto";
import type { SessionDTO } from "@/lib/contracts";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sessionId?: string }>;
}

/**
 * Chat page. `[id]` can be:
 *  - "new" — render an empty composer that the user binds (optionally) to a
 *    recording session via the `?sessionId=` query param. The first message
 *    creates a ChatSession row.
 *  - a real ChatSession id — load its messages and render the conversation.
 */
export default async function ChatPage({ params, searchParams }: PageProps) {
  const userId = await getDevUserId();
  const { id } = await params;
  const { sessionId: queryRecordingSessionId } = await searchParams;

  // List recently-updated chats for the sidebar drawer.
  const chats = await prisma.chatSession.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 30,
    include: { _count: { select: { messages: true } } },
  });
  const chatList = chats.map((c) =>
    toChatSessionDTO(c, { messageCount: c._count.messages })
  );

  // List a few recent recordings so the empty state can offer "ask about
  // this recording" shortcuts.
  const recordings = await prisma.session.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 6,
    include: { _count: { select: { segments: true } } },
  });
  const recordingSummaries: Array<
    Pick<SessionDTO, "id" | "title" | "sourceLang" | "targetLang" | "durationMs" | "createdAt">
  > = recordings.map((r) => ({
    id: r.id,
    title: r.title,
    sourceLang: r.sourceLang,
    targetLang: r.targetLang,
    durationMs: r.durationMs,
    createdAt: r.createdAt.toISOString(),
  }));

  if (id === "new") {
    // Empty composer. `sessionId` may pre-bind a recording.
    let prefillRecording: typeof recordingSummaries[number] | null = null;
    if (queryRecordingSessionId) {
      const r = await prisma.session.findFirst({
        where: { id: queryRecordingSessionId, userId },
        select: {
          id: true,
          title: true,
          sourceLang: true,
          targetLang: true,
          durationMs: true,
          createdAt: true,
        },
      });
      if (r) {
        prefillRecording = {
          id: r.id,
          title: r.title,
          sourceLang: r.sourceLang,
          targetLang: r.targetLang,
          durationMs: r.durationMs,
          createdAt: r.createdAt.toISOString(),
        };
      }
    }
    return (
      <ChatPanel
        chatList={chatList}
        recordings={recordingSummaries}
        mode="new"
        prefillRecordingId={prefillRecording?.id ?? null}
        prefillRecordingTitle={prefillRecording?.title ?? null}
      />
    );
  }

  // Existing chat.
  const row = await prisma.chatSession.findFirst({
    where: { id, userId },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      _count: { select: { messages: true } },
    },
  });
  if (!row) redirect("/dashboard/chat/new");

  let boundRecordingTitle: string | null = null;
  if (row.sessionId) {
    const r = await prisma.session.findUnique({
      where: { id: row.sessionId },
      select: { title: true },
    });
    boundRecordingTitle = r?.title ?? null;
  }

  return (
    <ChatPanel
      chatList={chatList}
      recordings={recordingSummaries}
      mode="existing"
      chatSession={toChatSessionDTO(row, { messageCount: row._count.messages })}
      initialMessages={row.messages.map(toChatMessageDTO)}
      boundRecordingTitle={boundRecordingTitle}
    />
  );
}
