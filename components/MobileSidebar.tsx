"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Menu, X } from "lucide-react";

import { SidebarNav } from "@/components/SidebarNav";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MobileSidebarProps {
  userName: string;
  userInitial: string;
}

/**
 * Mobile-only sidebar trigger + drawer. Renders a hamburger button that
 * opens a left-aligned slide-in Drawer hosting <SidebarNav inDrawer />.
 * The drawer auto-closes when the user clicks a nav link (onNavigate
 * callback). Above `lg` the parent layout shows the original sticky
 * sidebar column directly and hides this component.
 *
 * Uses Radix Dialog primitives directly because we don't have a Sheet
 * abstraction yet and DialogContent is centered-modal by default; the
 * styling override here is small enough to inline.
 */
export function MobileSidebar({ userName, userInitial }: MobileSidebarProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="打开侧边栏"
          className="h-9 w-9 lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </Button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/60 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            // Slide-in column from the left, full height. max-w keeps it
            // from eating the whole screen on slightly larger phones.
            "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-zinc-200 bg-white shadow-2xl outline-none dark:border-zinc-800 dark:bg-zinc-950",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
            "data-[state=closed]:duration-150 data-[state=open]:duration-200"
          )}
          aria-label="主导航"
        >
          {/* Both Title and Description are required by Radix Dialog
              a11y rules; missing either logs a console warning on every
              open. Visually hidden via sr-only since the drawer is
              self-explanatory. */}
          <DialogPrimitive.Title className="sr-only">主导航</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            访问录音、对话、词汇本、套餐和设置等页面
          </DialogPrimitive.Description>
          <DialogPrimitive.Close
            aria-label="关闭侧边栏"
            className="absolute right-3 top-3 rounded-md p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
          <SidebarNav
            userName={userName}
            userInitial={userInitial}
            inDrawer
            onNavigate={() => setOpen(false)}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export default MobileSidebar;
