"use client";

import * as React from "react";
import { signOut } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  Folder,
  BookOpen,
  MessageSquare,
  Share2,
  Vote,
  Settings,
  Languages,
  SunMoon,
  LogOut,
  Smartphone,
  AppWindow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SettingsDialog } from "@/components/SettingsDialog";
import { InviteCodeCard } from "@/components/InviteCodeCard";
import { UserMenuBadge } from "@/components/UserMenuBadge";
import { SidebarChatHistory } from "@/components/SidebarChatHistory";

export interface SidebarNavProps {
  userName?: string;
  userInitial?: string;
  subscription?: "Free" | "Pro" | "Team";
  className?: string;
}

interface NavEntry {
  href?: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** "button" entries are placeholders that don't navigate */
  kind?: "link" | "button";
  /** Optional id for entries that should trigger custom actions */
  action?: "settings";
  /** Marks the entry whose row is rendered via SidebarChatHistory. */
  feature?: "chat-history";
}

const NAV_ENTRIES: NavEntry[] = [
  { href: "/dashboard", label: "首页", icon: Home, kind: "link" },
  { href: "/dashboard/history", label: "文件夹", icon: Folder, kind: "link" },
  { href: "/dashboard/vocabulary", label: "词汇本", icon: BookOpen, kind: "link" },
  {
    href: "/dashboard/chat/new",
    label: "对话",
    icon: MessageSquare,
    kind: "link",
    feature: "chat-history",
  },
  { href: "/dashboard/shared-with-me", label: "共享", icon: Share2, kind: "link" },
  { href: "/dashboard/polls", label: "投票", icon: Vote, kind: "link" },
  { label: "设置", icon: Settings, kind: "button", action: "settings" },
];

export function SidebarNav({
  userName = "User",
  userInitial,
  subscription = "Free",
  className,
}: SidebarNavProps) {
  const pathname = usePathname() ?? "/";
  const initial = (userInitial ?? userName.charAt(0) ?? "U").toUpperCase();
  const [settingsOpen, setSettingsOpen] = React.useState(false);

  return (
    <aside
      className={cn(
        // sticky so the sidebar stays pinned while the main column scrolls.
        // Without this the aside is h-screen but rendered inline — once the
        // page grows past 100vh the whole sidebar scrolls away with it.
        "sticky top-0 flex h-screen w-72 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/60 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/60",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900 text-sm font-semibold text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="truncate text-sm font-medium">{userName}</div>
            <UserMenuBadge />
          </div>
          <Badge variant="secondary" className="mt-0.5 h-5 px-1.5 text-[10px]">
            {subscription}
          </Badge>
        </div>
      </div>

      <Separator />

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="flex flex-col gap-0.5">
          {NAV_ENTRIES.map((entry) => {
            const Icon = entry.icon;
            const isLink = entry.kind !== "button" && entry.href;
            const active = isLink && entry.href ? isActive(pathname, entry.href) : false;

            const baseRowClassName =
              "flex items-center gap-3 rounded-[10px] px-3 py-2 text-sm transition-colors";
            const activeClassName =
              "bg-zinc-200/70 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100";
            const inactiveClassName =
              "text-zinc-700 hover:bg-zinc-200/40 dark:text-zinc-300 dark:hover:bg-zinc-800/60";
            const itemClassName = cn(
              baseRowClassName,
              active ? activeClassName : inactiveClassName
            );

            if (entry.feature === "chat-history") {
              return (
                <li key={entry.label}>
                  <SidebarChatHistory
                    parentItemClassName={baseRowClassName}
                    topItemActiveClassName={activeClassName}
                    topItemInactiveClassName={inactiveClassName}
                  />
                </li>
              );
            }

            const onClickAction = entry.action === "settings"
              ? () => setSettingsOpen(true)
              : undefined;

            return (
              <li key={entry.label}>
                {isLink && entry.href ? (
                  <Link href={entry.href} className={itemClassName}>
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{entry.label}</span>
                  </Link>
                ) : (
                  <button
                    type="button"
                    className={cn(itemClassName, "w-full text-left")}
                    onClick={onClickAction}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{entry.label}</span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Invite reward card — sits between nav and the store badges */}
      <InviteCodeCard />

      {/* App badges */}
      <div className="grid grid-cols-2 gap-2 px-3 pb-2">
        <a
          href="#"
          className="flex items-center justify-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1.5 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <AppWindow className="h-3.5 w-3.5" />
          iOS
        </a>
        <a
          href="#"
          className="flex items-center justify-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1.5 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <Smartphone className="h-3.5 w-3.5" />
          Android
        </a>
      </div>

      <Separator />

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="切换语言"
          onClick={() => {
            /* no-op for phase 1 */
          }}
        >
          <Languages className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="切换主题"
          onClick={() => {
            /* no-op for phase 1 */
          }}
        >
          <SunMoon className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="退出登录"
          title="退出登录"
          onClick={() => {
            void signOut({ callbackUrl: "/login" });
          }}
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>

      {/* Settings dialog (controlled by 设置 nav entry) */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </aside>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  // Treat any /dashboard/chat/* route as the chat section.
  if (href.startsWith("/dashboard/chat")) return pathname.startsWith("/dashboard/chat");
  return pathname === href || pathname.startsWith(href + "/");
}

export default SidebarNav;
