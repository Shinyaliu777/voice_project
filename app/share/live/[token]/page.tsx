import { notFound } from "next/navigation";

import { prisma } from "@/lib/db";
import { LiveShareViewer } from "./viewer";

interface PageProps {
  params: Promise<{ token: string }>;
}

// Public — no auth required. The token itself is the bearer.
export default async function LiveSharePage({ params }: PageProps) {
  const { token } = await params;
  const share = await prisma.liveShareSession.findUnique({
    where: { token },
    include: {
      session: { select: { id: true, title: true, sourceLang: true, targetLang: true } },
    },
  });

  if (!share) {
    notFound();
  }

  const session = share.session;
  return (
    <LiveShareViewer
      token={token}
      initialTitle={session.title || "实时分享"}
      sourceLang={session.sourceLang}
      targetLang={session.targetLang}
    />
  );
}
