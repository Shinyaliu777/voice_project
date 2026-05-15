import { Share2 } from "lucide-react";

export default function SharedWithMePage() {
  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-3xl flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-zinc-100 text-zinc-400">
        <Share2 className="h-7 w-7" />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
        与我分享
      </h1>
      <p className="mt-3 max-w-md text-sm text-zinc-500">
        暂无分享 / 当有人分享内容给你时，会显示在这里
      </p>
    </div>
  );
}
