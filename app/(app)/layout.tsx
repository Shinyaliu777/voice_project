import type { ReactNode } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { SidebarNav } from "@/components/SidebarNav";
import { MobileSidebar } from "@/components/MobileSidebar";
import { SearchBar } from "@/components/SearchBar";
import { RecorderLane } from "@/components/RecorderLane";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { OnboardingTour } from "@/components/OnboardingTour";
import { prisma } from "@/lib/db";
import { getDevUser, getDevUserId } from "@/lib/dev-user";

// The entire authenticated shell depends on per-user DB data (current user,
// sessions, folders, ...). Forcing dynamic rendering keeps Next from trying
// to statically prerender pages like /dashboard/polls and /dashboard/search
// at build time — they need a live request to be meaningful anyway.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getDevUser();
  const userName = user.name ?? "Dev User";
  const userInitial = (user.name ?? "D").trim().charAt(0).toUpperCase();

  // Hydrate the Recorder with the most recent unfinished session so a
  // page reload mid-recording resumes the same language defaults. We
  // query at the layout level (not in dashboard/page.tsx anymore) because
  // Recorder is now mounted in the layout — see RecorderLane for why.
  // Only the *first* render uses these values; Recorder's internal state
  // ignores subsequent prop changes, so the unfinished record won't keep
  // overriding live state every time the user navigates within /dashboard.
  const userId = await getDevUserId();
  const unfinished = await prisma.session.findFirst({
    where: {
      userId,
      status: { in: ["idle", "recording", "uploading"] },
    },
    orderBy: { updatedAt: "desc" },
    select: {
      sourceLang: true,
      targetLang: true,
      title: true,
    },
  });

  return (
    <div className="flex min-h-screen bg-zinc-50">
      {/* Desktop: persistent sidebar column. Below lg the column is hidden
          and MobileSidebar (rendered in the header) handles navigation. */}
      <SidebarNav
        userName={userName}
        userInitial={userInitial}
        className="hidden lg:flex"
      />
      <main className="flex flex-1 min-w-0 flex-col">
        <header className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-zinc-200 bg-white/80 px-3 backdrop-blur sm:gap-3 sm:px-4">
          <MobileSidebar userName={userName} userInitial={userInitial} />
          <Link
            href="/dashboard"
            className="text-[15px] font-bold tracking-tight text-zinc-900 hover:opacity-80 sm:text-[16px]"
          >
            Voice Project
          </Link>
          {/* Search collapses below sm — small phones reach it through
              the nav (a future enhancement could add an icon-trigger). */}
          <SearchBar className="hidden flex-1 sm:flex" />
          <div className="flex-1 sm:hidden" />
          <Button variant="default" size="sm" asChild>
            <Link href="/dashboard">
              <Plus className="h-4 w-4" />
              {/* Label hides on tiny screens to free up header room. */}
              <span className="hidden sm:inline">新建录音</span>
            </Link>
          </Button>
        </header>
        <div className="relative flex-1">
          {/* RecorderLane is always-mounted so the recording survives
              client-side navigation to chat / history / vocabulary /
              etc. Visible only on /dashboard; hidden on other routes
              (display:none keeps the React subtree alive). Stopping is
              an explicit user action — "结束录制" inside Recorder. */}
          <RecorderLane
            defaultSourceLang={unfinished?.sourceLang ?? "en"}
            defaultTargetLang={unfinished?.targetLang ?? "zh"}
            defaultTitle={unfinished?.title || undefined}
          />
          {children}
        </div>
      </main>
      <Toaster />
      {/* First-visit walkthrough. Self-hides via localStorage flag.
          The "重新开始新手教程" button in SettingsDialog clears the flag;
          we re-check on every navigation, so the tour shows after settings
          reset without needing a hard page reload. */}
      <OnboardingTour />
    </div>
  );
}
