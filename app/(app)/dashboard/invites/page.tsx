import { InvitesManager } from "@/components/InvitesManager";

export const dynamic = "force-dynamic";

export default function InvitesPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          我的邀请
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          内测期间，新用户需要邀请码才能注册。把生成的邀请码或邀请链接分享给朋友。
        </p>
      </div>
      <InvitesManager />
    </div>
  );
}
