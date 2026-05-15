import type { ReactNode } from "react";
import { SidebarNav } from "@/components/SidebarNav";
import { Toaster } from "@/components/ui/toaster";
import { getDevUser } from "@/lib/dev-user";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getDevUser();

  return (
    <div className="flex min-h-screen bg-zinc-50">
      <aside className="w-60 shrink-0 border-r border-zinc-200 bg-white">
        <SidebarNav
          userName={user.name ?? "Dev User"}
          userInitial={(user.name ?? "D").trim().charAt(0).toUpperCase()}
        />
      </aside>
      <main className="flex-1 min-w-0">{children}</main>
      <Toaster />
    </div>
  );
}
