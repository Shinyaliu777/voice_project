import { redirect } from "next/navigation";
import LoginForm from "./LoginForm";
import { auth } from "@/auth";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const session = await auth();
  const { callbackUrl } = await searchParams;
  if (session?.user) {
    redirect(callbackUrl ?? "/dashboard");
  }

  const allowDevLogin =
    process.env.NODE_ENV !== "production" ||
    process.env.ALLOW_DEV_LOGIN === "1";
  const hasGoogle = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Voice Project
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          登录后开始录制 · 你的录音只你能看见
        </p>
        <LoginForm
          callbackUrl={callbackUrl ?? "/dashboard"}
          hasGoogle={hasGoogle}
          allowDevLogin={allowDevLogin}
        />
      </div>
    </main>
  );
}
