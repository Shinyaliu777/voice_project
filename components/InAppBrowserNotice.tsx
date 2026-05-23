"use client";

import * as React from "react";
import { Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";

/**
 * Detects in-app webviews that Google blocks for OAuth (the
 * "disallowed_useragent" policy) and surfaces a clear
 * instruction to open the link in a real system browser.
 *
 * Google's enforcement page:
 *   https://developers.googleblog.com/en/modernizing-oauth-interactions-in-native-apps-for-better-usability-and-security/
 *
 * Affected webviews (non-exhaustive):
 *   - WeChat (MicroMessenger)
 *   - QQ Browser embedded webview (QQ / MQQBrowser)
 *   - DingTalk (DingTalk)
 *   - WeCom (wxwork)
 *   - Feishu / Lark (Lark)
 *   - Weibo (Weibo)
 *   - Facebook / Instagram in-app
 *   - TikTok / ByteDance webview
 *
 * The component renders nothing on real browsers (Chrome,
 * Safari, Firefox, Edge), nothing during SSR (no `window`),
 * and nothing on desktop — only mobile in-app webviews
 * trigger the banner.
 */

interface DetectionResult {
  isInApp: boolean;
  appName: string | null;
}

function detect(ua: string): DetectionResult {
  const lower = ua.toLowerCase();
  // Order matters — most specific first
  const probes: Array<[RegExp, string]> = [
    [/micromessenger/, "微信"],
    [/wxwork/, "企业微信"],
    [/dingtalk/, "钉钉"],
    [/(mqqbrowser|qq\/)/i, "QQ"],
    [/lark/, "飞书 / Lark"],
    [/weibo/, "微博"],
    [/fb_iab|fbav|fban/, "Facebook"],
    [/instagram/, "Instagram"],
    [/(bytedancewebview|musical_ly|tiktok)/, "TikTok / ByteDance"],
    [/baiduboxapp/, "百度 App"],
  ];
  for (const [re, name] of probes) {
    if (re.test(lower)) return { isInApp: true, appName: name };
  }
  return { isInApp: false, appName: null };
}

export function InAppBrowserNotice() {
  const [state, setState] = React.useState<DetectionResult>({
    isInApp: false,
    appName: null,
  });

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    setState(detect(window.navigator.userAgent));
  }, []);

  if (!state.isInApp) return null;

  const url = typeof window !== "undefined" ? window.location.href : "";

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("已复制链接，粘贴到浏览器地址栏");
    } catch {
      toast.error("复制失败，请手动选择 URL 复制");
    }
  };

  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700/60 dark:bg-amber-950/30">
      <div className="flex items-start gap-2">
        <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex-1">
          <p className="font-medium text-amber-900 dark:text-amber-100">
            在 {state.appName ?? "当前浏览器"} 内无法使用 Google 登录
          </p>
          <p className="mt-1 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
            Google 出于安全原因禁止应用内嵌浏览器登录。<b>请改用上面的「邮箱登录」</b>——
            点「发送链接」后到邮箱里点链接即可，任何浏览器都能用。<br />
            或者：点右上角「<span className="font-mono">···</span>」→
            「<b>在浏览器中打开</b>」（Safari / Chrome / Edge）再用 Google 登。
          </p>
          <button
            type="button"
            onClick={copyLink}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100 dark:border-amber-700/60 dark:bg-amber-900/40 dark:text-amber-50 dark:hover:bg-amber-900/60"
          >
            <Copy className="h-3.5 w-3.5" />
            复制本页链接
          </button>
        </div>
      </div>
    </div>
  );
}
