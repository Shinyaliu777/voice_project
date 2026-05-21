import { Suspense } from "react";

import { AdminConsole } from "@/components/admin/AdminConsole";

export const dynamic = "force-dynamic";

/**
 * /admin
 *
 * Single-page admin console with three tabs: 用户 / 兑换码 / 概览.
 * Server gate is in the layout (`isCurrentUserAdmin`). All interactive
 * bits live in the client component below — server fetches happen via
 * the JSON APIs under /api/admin/*.
 */
export default function AdminPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-zinc-500">加载中…</div>}>
      <AdminConsole />
    </Suspense>
  );
}
