import type { ReactNode } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { SidebarNav } from "@/components/SidebarNav";
import { MobileSidebar } from "@/components/MobileSidebar";
import { SearchBar } from "@/components/SearchBar";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { OnboardingTour } from "@/components/OnboardingTour";
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
              <span className="hidden xs:inline sm:inline">新建录音</span>
            </Link>
          </Button>
        </header>
        <div className="flex-1">{children}</div>
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
