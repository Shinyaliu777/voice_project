"use client";

import * as React from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdminUsersTab } from "./AdminUsersTab";
import { AdminCodesTab } from "./AdminCodesTab";

/**
 * /admin console — tabbed UI for the two operational tools (users +
 * redemption codes). Each tab is self-contained: it owns its own
 * fetch loop, search input, and refresh-after-mutation pattern.
 *
 * Why a single tabbed page instead of /admin/users + /admin/codes:
 * less route boilerplate, the URL doesn't matter much (admin tools
 * aren't bookmarked), and the user keeps their search state when
 * flipping between tabs without a navigation.
 */
export function AdminConsole() {
  return (
    <div className="mx-auto w-full max-w-6xl px-3 py-6 sm:px-4 md:px-6 md:py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          管理后台
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          管理用户、发放兑换码、调整分钟数。所有改动都会落到分钟流水（MinuteTransaction）。
        </p>
      </header>
      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">用户</TabsTrigger>
          <TabsTrigger value="codes">兑换码</TabsTrigger>
        </TabsList>
        <TabsContent value="users" className="pt-4">
          <AdminUsersTab />
        </TabsContent>
        <TabsContent value="codes" className="pt-4">
          <AdminCodesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
