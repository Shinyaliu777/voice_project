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
import { AnalyticsBoot } from "@/components/AnalyticsBoot";
import { getDevUser } from "@/lib/dev-user";

// The entire authenticated shell depends on per-user DB data (current user,
// sessions, folders, ...). Forcing dynamic rendering keeps Next from trying
// to statically prerender pages like /dashboard/polls and /dashboard/search
// at build time — they need a live request to be meaningful anyway.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getDevUser();
  const userName = user.name ?? "Dev User";
  const userInitial = (user.name ?? "D").trim().charAt(0).toUpperCase();

  // Previously this layout ran an extra `prisma.session.findFirst()` to
  // hydrate Recorder with the most-recent unfinished session's language
  // defaults. That query fires on EVERY client-side navigation in dev mode
  // (RSC has no cross-request cache in dev), adding 100-300ms latency to
  // every sidebar click. The user perceived sidebar nav as sluggish.
  //
  // Drop the query entirely. Recorder defaults to en/zh internally —
  // which is what the unfinished-session lookup returned 90%+ of the
  // time anyway. Anyone resuming a non-en/zh session will pick the
  // language once and the recorder UI persists it from that point.

  return (
    <div className="flex min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Desktop: persistent sidebar column. Below lg the column is hidden
          and MobileSidebar (rendered in the header) handles navigation. */}
      <SidebarNav
        userName={userName}
        userInitial={userInitial}
        className="hidden lg:flex"
      />
      <main className="flex flex-1 min-w-0 flex-col">
        <header className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-zinc-200 bg-white/80 px-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80 sm:gap-3 sm:px-4">
          <MobileSidebar userName={userName} userInitial={userInitial} />
          <Link
            href="/dashboard"
            className="text-[15px] font-bold tracking-tight text-zinc-900 hover:opacity-80 dark:text-zinc-50 sm:text-[16px]"
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
          <RecorderLane />
          {children}
        </div>
      </main>
      <Toaster />
      {/* First-visit walkthrough. Self-hides via localStorage flag.
          The "重新开始新手教程" button in SettingsDialog clears the flag;
          we re-check on every navigation, so the tour shows after settings
          reset without needing a hard page reload. */}
      <OnboardingTour />
      {/* Analytics boot — calls identify(userId) once. No-op when
          NEXT_PUBLIC_POSTHOG_KEY is unset (local dev / preview). */}
      <AnalyticsBoot userId={user.id} />
    </div>
  );
}
