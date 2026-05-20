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
  inviteRequired,
  inviteCodeFromQuery,
}: {
  callbackUrl: string;
  hasGoogle: boolean;
  allowDevLogin: boolean;
  /** When true, the user must enter + validate an invite code before
   *  sign-in is allowed (validate sets a short-lived cookie the
   *  signIn callback reads). Existing accounts can still log in
   *  without one — the gate only fires for new account creation. */
  inviteRequired: boolean;
  /** Pre-fill from /login?invite=XXX (clicked from a copied invite
   *  link). User still needs to tap "验证" so we don't auto-burn the
   *  cookie before they confirm the email they want to sign in with. */
  inviteCodeFromQuery: string | null;
}) {
  const [email, setEmail] = React.useState("");
  const [inviteCode, setInviteCode] = React.useState(
    inviteCodeFromQuery?.trim().toUpperCase() ?? ""
  );
  const [inviteOk, setInviteOk] = React.useState(false);
  const [inviteValidating, setInviteValidating] = React.useState(false);
  const [inviterLabel, setInviterLabel] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  /** Closed-beta gate: a new account can't be created without a valid
   *  pending_invite cookie. Existing accounts can always log in — but
   *  we don't know from the client whether the entered email is new or
   *  existing, so the safest UX is "validate code first, then sign in"
   *  whenever INVITE_REQUIRED is set. */
  const needsInvite = inviteRequired && !inviteOk;

  const validateInvite = async () => {
    const trimmed = inviteCode.trim().toUpperCase();
    if (!trimmed) {
      toast.error("请输入邀请码");
      return;
    }
    setInviteValidating(true);
    try {
      const resp = await fetch("/api/invite/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      const data = (await resp.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            inviter?: { email: string; name: string | null };
          }
        | null;
      if (!resp.ok || !data?.ok) {
        toast.error(data?.error ?? "邀请码无效");
        return;
      }
      setInviteOk(true);
      setInviterLabel(data.inviter?.name ?? data.inviter?.email ?? null);
      toast.success("邀请码有效");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "网络异常");
    } finally {
      setInviteValidating(false);
    }
  };

  const handleGoogle = async () => {
    if (needsInvite) {
      toast.error("请先验证邀请码");
      return;
    }
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
    if (needsInvite) {
      toast.error("请先验证邀请码");
      return;
    }
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
      {inviteRequired ? (
        <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
            邀请码 {inviteOk ? "✓" : "（新用户必填）"}
          </label>
          <div className="flex gap-2">
            <Input
              type="text"
              placeholder="例如 K3X9P7L2"
              value={inviteCode}
              onChange={(e) => {
                setInviteCode(e.target.value);
                setInviteOk(false);
                setInviterLabel(null);
              }}
              disabled={busy || inviteOk}
              className="font-mono uppercase tracking-wider"
              maxLength={16}
            />
            <Button
              type="button"
              variant={inviteOk ? "default" : "outline"}
              onClick={validateInvite}
              disabled={busy || inviteValidating || inviteOk || !inviteCode.trim()}
            >
              {inviteValidating ? "校验中…" : inviteOk ? "已验证" : "验证"}
            </Button>
          </div>
          {inviteOk && inviterLabel ? (
            <p className="text-[11px] text-emerald-700 dark:text-emerald-400">
              来自 {inviterLabel} 的邀请
            </p>
          ) : (
            <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              已有账号可直接登录，无需邀请码。
            </p>
          )}
        </div>
      ) : null}

      {hasGoogle ? (
        <Button
          type="button"
          className="w-full"
          onClick={handleGoogle}
          disabled={busy || needsInvite}
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
          <Button
            type="submit"
            variant="outline"
            disabled={busy || !email.trim() || needsInvite}
          >
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
