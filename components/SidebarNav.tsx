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
  Sparkles,
  Languages,
  Moon,
  Sun,
  LogOut,
  Gift,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SettingsDialog } from "@/components/SettingsDialog";
import { UserMenuBadge } from "@/components/UserMenuBadge";
import { SidebarChatHistory } from "@/components/SidebarChatHistory";


export interface SidebarNavProps {
  userName?: string;
  userInitial?: string;
  subscription?: "Free" | "Pro" | "Team";
  className?: string;
  /** When true, render filling its parent container (no sticky / h-screen /
   *  fixed width / border-r) — used by MobileSidebar so the nav fits inside
   *  a slide-in Dialog instead of as a column in the page layout. */
  inDrawer?: boolean;
  /** Called when a nav link is clicked. Drawer wrapper uses this to close
   *  itself after navigation. */
  onNavigate?: () => void;
  /** Show the /admin entry. Set by the (app) layout based on
   *  isCurrentUserAdmin(). Non-admins never see the link at all. */
  isAdmin?: boolean;
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
  /** Only render when SidebarNavProps.isAdmin === true. */
  adminOnly?: boolean;
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
  { href: "/dashboard/invites", label: "邀请", icon: Gift, kind: "link" },
  { href: "/dashboard/billing", label: "套餐", icon: Sparkles, kind: "link" },
  { href: "/admin", label: "管理后台", icon: ShieldCheck, kind: "link", adminOnly: true },
  { label: "设置", icon: Settings, kind: "button", action: "settings" },
];

interface SubscriptionResp {
  plan?: { displayName?: string; isPremium?: boolean; monthlyMinutes?: number };
}

/**
 * Compact upgrade card shown in the sidebar between nav and footer. Reads
 * the current subscription; hides itself for paid users (already upgraded).
 * Free users see a one-line CTA → /dashboard/billing.
 */
function UpgradeCard() {
  const [planName, setPlanName] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/subscription");
        if (!r.ok) return;
        const data = (await r.json()) as SubscriptionResp;
        if (!alive) return;
        if (data.plan?.isPremium) {
          setPlanName(null);
        } else {
          setPlanName(data.plan?.displayName ?? "Free");
        }
      } catch {
        /* ignore — keep card hidden if probe fails */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!planName) return null;

  return (
    <div className="mx-3 mb-2 rounded-lg border border-zinc-200 bg-gradient-to-br from-amber-50 to-orange-50 p-3 dark:border-zinc-800 dark:from-amber-950/30 dark:to-orange-950/20">
      <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-900 dark:text-zinc-100">
        <Sparkles className="h-3.5 w-3.5 text-amber-500" />
        <span>升级 Business</span>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-zinc-600 dark:text-zinc-400">
        当前 {planName} · 升级后解锁无限录音、Pro 推理模型、优先支持
      </p>
      <Link
        href="/dashboard/billing"
        className="mt-2 inline-flex w-full items-center justify-center rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-50 transition-colors hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        查看套餐
      </Link>
    </div>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  if (href.startsWith("/dashboard/chat")) return pathname.startsWith("/dashboard/chat");
  return pathname === href || pathname.startsWith(href + "/");
}

export function SidebarNav({
  userName = "User",
  userInitial,
  subscription = "Free",
  className,
  inDrawer,
  onNavigate,
  isAdmin,
}: SidebarNavProps) {
  const pathname = usePathname() ?? "/";
  const initial = (userInitial ?? userName.charAt(0) ?? "U").toUpperCase();
  const [settingsOpen, setSettingsOpen] = React.useState(false);

  // ---- user preferences (theme + font size) ----
  // SidebarNav is the one client component guaranteed to be mounted
  // everywhere in the app shell, so it doubles as the global "apply
  // user.settings" hook. Single source of truth is /api/user/settings
  // (the same source SettingsDialog writes to), which keeps the
  // bottom-bar toggle and the Settings dialog in sync — earlier they
  // diverged because the toggle wrote localStorage while the dialog
  // wrote user.settings.theme.
  const [isDark, setIsDark] = React.useState(false);
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/user/settings");
        if (!resp.ok || cancelled) return;
        const data = (await resp.json()) as {
          settings?: { theme?: string; fontSize?: number };
        };
        const s = data.settings ?? {};
        // theme — "light" / "dark" / "system" (= follow OS pref)
        const root = document.documentElement;
        if (s.theme === "dark") {
          root.classList.add("dark");
        } else if (s.theme === "light") {
          root.classList.remove("dark");
        } else if (typeof window !== "undefined" && window.matchMedia) {
          // "system" or unset — follow OS
          const prefersDark = window.matchMedia(
            "(prefers-color-scheme: dark)"
          ).matches;
          root.classList.toggle("dark", prefersDark);
        }
        setIsDark(root.classList.contains("dark"));
        // font size — apply to html so all rem-based Tailwind sizes scale
        if (
          typeof s.fontSize === "number" &&
          s.fontSize >= 10 &&
          s.fontSize <= 22
        ) {
          root.style.fontSize = `${s.fontSize}px`;
        }
      } catch {
        /* ignore — falls back to OS preference / defaults */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const toggleTheme = React.useCallback(() => {
    if (typeof document === "undefined") return;
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    setIsDark(next);
    // Persist to user.settings so SettingsDialog stays in sync and
    // the preference survives reloads + cross-device sign-in.
    void fetch("/api/user/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: next ? "dark" : "light" }),
    }).catch(() => {
      /* best-effort — class is already applied client-side */
    });
  }, []);

  return (
    <aside
      className={cn(
        // Desktop: sticky column on the left, fixed w-72, h-screen so it
        // pins while the main column scrolls. Drawer mode strips all of
        // that — fills the slide-in container instead.
        inDrawer
          ? "flex h-full w-full flex-col bg-zinc-50/95 dark:bg-zinc-950/95"
          : "sticky top-0 flex h-screen w-72 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/60 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/60",
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
          {NAV_ENTRIES.filter((e) => !e.adminOnly || isAdmin).map((entry) => {
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
                  <Link
                    href={entry.href}
                    className={itemClassName}
                    onClick={onNavigate}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{entry.label}</span>
                  </Link>
                ) : (
                  <button
                    type="button"
                    className={cn(itemClassName, "w-full text-left")}
                    onClick={() => {
                      onClickAction?.();
                      // Settings opens a modal — closing the drawer is
                      // actually right because the modal sits above.
                      onNavigate?.();
                    }}
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

      {/* Upgrade CTA — only for free-plan users. Invite-code card +
          iOS/Android badges removed: invites are still a Wave 2.3 todo
          and we don't have native apps. */}
      <UpgradeCard />

      <Separator />

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="切换语言"
          title="切换界面语言"
          onClick={() => {
            // UI is hard-coded zh-CN today; full i18n is out of scope
            // for this pass. Keep the button as a discoverable
            // placeholder rather than a no-op the user can't tell from
            // a broken click.
            toast("界面语言切换即将上线");
          }}
        >
          <Languages className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={isDark ? "切换到浅色主题" : "切换到深色主题"}
          title={isDark ? "切换到浅色主题" : "切换到深色主题"}
          onClick={toggleTheme}
        >
          {isDark ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
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

export default SidebarNav;
