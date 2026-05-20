"use client";

import * as React from "react";
import { signIn } from "next-auth/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Login form. The optional invite-code section is purely for
 * attribution — signup never requires a code. The two flows:
 *
 *   - Normal signup: just click Google / type dev-login email
 *   - With referral: paste/type code → we auto-call /validate which
 *     sets a cookie → then proceed with the usual provider button.
 *     The cookie carries the code through OAuth so events.createUser
 *     stamps invitedById.
 *
 * When the URL has `?invite=CODE`, we auto-validate on mount so the
 * user doesn't have to click anything. They can still proceed without
 * waiting — sign-in works either way; validation just adds
 * attribution if it lands first.
 */
export default function LoginForm({
  callbackUrl,
  hasGoogle,
  allowDevLogin,
  inviteCodeFromQuery,
}: {
  callbackUrl: string;
  hasGoogle: boolean;
  allowDevLogin: boolean;
  /** Pre-fill from /login?invite=XXX (clicked from a copied invite
   *  link). Auto-validates on mount so a single click on the invite
   *  link is enough — no extra "verify" button to press. */
  inviteCodeFromQuery: string | null;
}) {
  const [email, setEmail] = React.useState("");
  const [inviteCode, setInviteCode] = React.useState(
    inviteCodeFromQuery?.trim() ?? ""
  );
  const [inviteOk, setInviteOk] = React.useState(false);
  const [inviteValidating, setInviteValidating] = React.useState(false);
  const [inviterLabel, setInviterLabel] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const validateInvite = React.useCallback(
    async (raw: string, silentSuccess = false) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
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
          // Silent failure on auto-validate (URL-driven) — the user
          // didn't ask for this, no reason to nag.
          if (!silentSuccess) {
            toast.error(data?.error ?? "邀请码无效");
          }
          setInviteOk(false);
          setInviterLabel(null);
          return;
        }
        setInviteOk(true);
        setInviterLabel(data.inviter?.name ?? data.inviter?.email ?? null);
        if (!silentSuccess) {
          toast.success("邀请码已识别");
        }
      } catch (err) {
        if (!silentSuccess) {
          toast.error(err instanceof Error ? err.message : "网络异常");
        }
      } finally {
        setInviteValidating(false);
      }
    },
    []
  );

  // Auto-validate when the URL carried a code.
  React.useEffect(() => {
    if (inviteCodeFromQuery && inviteCodeFromQuery.trim()) {
      void validateInvite(inviteCodeFromQuery, true);
    }
  }, [inviteCodeFromQuery, validateInvite]);

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
      window.location.href = res?.url ?? callbackUrl;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "登录失败");
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 flex flex-col gap-3">
      {/* Optional referral code section. Always visible (signup is
          always open); displays an "accepted" badge once we've
          validated. */}
      <details
        className="rounded-lg border border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40"
        open={inviteCode.length > 0 || inviteOk}
      >
        <summary className="cursor-pointer select-none px-3 py-2 text-xs text-zinc-600 dark:text-zinc-300">
          {inviteOk
            ? `✓ 已应用邀请码${inviterLabel ? ` · 来自 ${inviterLabel}` : ""}`
            : "有邀请码？（可选）"}
        </summary>
        <div className="px-3 pb-3 pt-1">
          <div className="flex gap-2">
            <Input
              type="text"
              placeholder="K3X9-P7L2-MR"
              value={inviteCode}
              onChange={(e) => {
                setInviteCode(e.target.value);
                setInviteOk(false);
                setInviterLabel(null);
              }}
              onBlur={(e) => {
                // Auto-validate when the user finishes typing — saves
                // the click on a separate "verify" button.
                if (e.target.value.trim() && !inviteOk) {
                  void validateInvite(e.target.value);
                }
              }}
              disabled={busy || inviteValidating}
              className="font-mono uppercase tracking-wider"
              maxLength={20}
            />
            {!inviteOk ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void validateInvite(inviteCode)}
                disabled={busy || inviteValidating || !inviteCode.trim()}
              >
                {inviteValidating ? "校验中" : "应用"}
              </Button>
            ) : null}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            没有邀请码也可以正常注册。填写后用作邀请人归属。
          </p>
        </div>
      </details>

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
