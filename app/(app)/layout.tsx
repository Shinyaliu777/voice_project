import type { ReactNode } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { SidebarNav } from "@/components/SidebarNav";
import { SearchBar } from "@/components/SearchBar";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { getDevUser } from "@/lib/dev-user";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getDevUser();

  return (
    <div className="flex min-h-screen bg-zinc-50">
      <SidebarNav
        userName={user.name ?? "Dev User"}
        userInitial={(user.name ?? "D").trim().charAt(0).toUpperCase()}
      />
      <main className="flex flex-1 min-w-0 flex-col">
        <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-zinc-200 bg-white/80 px-4 backdrop-blur">
          <Link
            href="/dashboard"
            className="text-[16px] font-bold tracking-tight text-zinc-900 hover:opacity-80"
          >
            Voice Project
          </Link>
          <SearchBar className="flex-1" />
          <Button variant="default" size="sm" asChild>
            <Link href="/dashboard">
              <Plus className="h-4 w-4" />
              <span>新建录音</span>
            </Link>
          </Button>
        </header>
        <div className="flex-1">{children}</div>
      </main>
      <Toaster />
    </div>
  );
}
