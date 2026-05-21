import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { isCurrentUserAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

/**
 * Server-side admin gate. Anyone who isn't an admin gets bounced
 * back to the dashboard with no flashing of admin chrome (since the
 * check runs before any layout HTML is sent). Login-required check
 * is already handled by the outer middleware.ts → /(app) layout.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { isAdmin } = await isCurrentUserAdmin();
  if (!isAdmin) {
    redirect("/dashboard");
  }
  return <>{children}</>;
}
