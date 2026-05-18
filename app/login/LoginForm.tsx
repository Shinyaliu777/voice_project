"use client";

import * as React from "react";
import { signIn } from "next-auth/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginForm({
  callbackUrl,
  hasGoogle,
  allowDevLogin,
}: {
  callbackUrl: string;
  hasGoogle: boolean;
  allowDevLogin: boolean;
}) {
  const [email, setEmail] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const handleGoogle = async () => {
    setBusy(true);
    try {
      await signIn("google", { callbackUrl });
    } catch {
      toast.error("Google 登录失败");
      setBusy(false);
    }
  };

  const handleDev = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    try {
      const res = await signIn("dev-login", {
        email: email.trim(),
        callbackUrl,
        redirect: false,
      });
      if (res?.error) throw new Error(res.error);
      // Manual navigation since redirect: false.
      window.location.href = res?.url ?? callbackUrl;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "登录失败");
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 flex flex-col gap-3">
      {hasGoogle ? (
        <Button
          type="button"
          className="w-full"
          onClick={handleGoogle}
          disabled={busy}
        >
          使用 Google 登录
        </Button>
      ) : null}

      {allowDevLogin ? (
        <form onSubmit={handleDev} className="flex flex-col gap-2">
          {hasGoogle ? (
            <div className="flex items-center gap-2 py-2 text-xs text-zinc-400">
              <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
              <span>或开发者登录</span>
              <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            </div>
          ) : null}
          <Input
            type="email"
            placeholder="dev@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={busy}
          />
          <Button type="submit" variant="outline" disabled={busy || !email.trim()}>
            以此邮箱登录（开发用）
          </Button>
          <p className="text-[11px] leading-relaxed text-zinc-400">
            开发模式：不验证密码、不发邮件、不走 OAuth — 仅本地或内网测试使用。
            生产环境请设置 GOOGLE_CLIENT_ID/SECRET 并取消 ALLOW_DEV_LOGIN。
          </p>
        </form>
      ) : null}

      {!hasGoogle && !allowDevLogin ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
          没有可用的登录方式：请在服务端设置 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET，
          或开启 ALLOW_DEV_LOGIN=1。
        </p>
      ) : null}
    </div>
  );
}
