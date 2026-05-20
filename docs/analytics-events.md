# Analytics events

内测期产品观测埋点的事件目录。每个事件都通过 `lib/analytics.ts` 的 `track(name, props)` 发送到自托管 PostHog。

## 选型背景

| 工具 | 国内访问 | 自托管 | 产品分析 | 备注 |
| --- | --- | --- | --- | --- |
| Mixpanel | ⚠️ api.mixpanel.com 间歇被墙 | ❌ SaaS only | ✅ | lecsync 用的就是它 — 反编译能看到他们也吃过这个亏 |
| PostHog | ✅ 自己反代到 `ph.cyanclay.org` | ✅ docker-compose | ✅ funnels / retention / replay | **首选** |
| Plausible | ✅ | ✅ | ❌ 只有 web analytics | 不能回答"用户卡哪、什么最常失败" |
| Umami | ✅ | ✅ | ❌ 只有 web analytics | 同上 |

结论：**PostHog 自托管**。一个 docker-compose 起在同台机器或邻近服务器上，反代到 `ph.cyanclay.org`，前端 JS 从这个域加载 + 上报，零 GFW 依赖，且能直接出留存 / 漏斗 / session replay 等内测期最需要的视图。

## 环境变量

```bash
# 服务端不需要，只前端注入
NEXT_PUBLIC_POSTHOG_KEY="<phc_xxx>"
NEXT_PUBLIC_POSTHOG_HOST="https://ph.cyanclay.org"
```

`NEXT_PUBLIC_POSTHOG_KEY` 缺失时，`track()` / `identify()` / `reset()` 全部静默 no-op — 本地开发 / 预览部署不需要起 PostHog。

## 隐私准则（必读）

事件 props **绝不**包含：
- 邮箱、姓名、电话
- 转录文本（`utterance.sourceText` / `translatedText`）
- 纪要内容（`minutesSection.narrative` / `points`）
- 用户输入的搜索词、对话内容、笔记标题

允许的 props：
- 内部 id（sessionId、tokenHash）— PostHog 已经按 distinct_id 隔离
- 枚举值（audioSource、translationMode、format）
- 计数 / 时长（durationMs、statusCode）
- 错误名（err.name 是 "TypeError" 这样的类名，不是 user message）

## 用户识别

| 函数 | 时机 | Where |
| --- | --- | --- |
| `identify(userId)` | 应用加载、`(app)/layout.tsx` 拿到 session.user 后 | `components/AnalyticsBoot.tsx` |
| 匿名 `track()` | viewer (share/live/[token]) 打开分享链接 | PostHog 自动用本地 distinct_id |
| `reset()` | 退出登录、账号切换 | 暂未接入（next-auth v5 signOut 触发） |

## 事件目录

### app boot

| Event | 触发 | Props |
| --- | --- | --- |
| `$pageview` | 自动（PostHog SDK） | url, referrer |
| `$pageleave` | 自动（PostHog SDK） | url, $session_id |

### Recorder

| Event | 触发 | Props |
| --- | --- | --- |
| `recording_started` | `startRecording()` 内、`rec.start()` 成功之后 | `sessionId`, `audioSource` (`microphone`/`system`/`file`), `sourceLang`, `targetLang`, `translationMode` (`off`/`local`/`cloud`), `resumed` (bool) |
| `recording_stopped` | `stopRecording()` 正常完成 | `sessionId`, `durationMs`, `audioSource`, `translationMode` |
| `recording_failed` | `startRecording()` catch 或 `stopRecording()` catch | `errorName` (err.name), `stage` (`start`/`stop`), `sessionId`, `durationMs` |
| `chunk_upload_failed` | `RecorderError.code === "chunk_upload_failed"` 在 `handleEvent` 里 | `statusCode` (从消息里解析的 HTTP 状态), `recoverable` (bool) |

### Minutes

| Event | 触发 | Props |
| --- | --- | --- |
| `minutes_generated` | `GenerateMinutesButton` 拿到 200 响应 | `sessionId`, `durationMs` (前端测的端到端耗时) |
| `minutes_failed` | `GenerateMinutesButton` catch | `sessionId`, `durationMs`, `errorName` |

> 实时纪要的增量刷新（`refreshLiveMinutes`）刻意不埋 — 一场录音 N 次刷新会淹没事件流。如果要看实时纪要的可用性，看 `bug_encountered` source=`recorder` 里的 LLM 相关 error code。

### Share

| Event | 触发 | Props |
| --- | --- | --- |
| `share_link_created` | `LiveShareDialog` 拿到 mint 200 | `role: "host"`, `sessionId` |
| `share_link_opened` | viewer 页面（`/share/live/[token]`）首次挂载 | `role: "viewer"`, `tokenHash` (DJB2 of token — 不发原 token) |

### Settings

| Event | 触发 | Props |
| --- | --- | --- |
| `settings_changed` | `SettingsDialog.update()` 在初次加载后改了某个键 | `key` (`theme` / `fontSize` / `floatingShowTranslation` / ...) |

> 故意不发 value — slider 拖动会触发几十次 update，只关心"用户在动哪个设置"，不关心他最后停在哪。

### Errors (catch-all)

| Event | 触发 | Props |
| --- | --- | --- |
| `bug_encountered` | toast.error 同时触发 | `source` (`recorder` / `chat` / `export`), 加上各自 source 特定字段 |

source-specific props:
- `recorder`: `code` (recorder error code), `recoverable`
- `chat`: `errorName`
- `export`: `errorName` / `statusCode`, `format`

## 不埋什么（明确决定）

- **Floating subtitle window 开 / 关**：低频，已通过 `settings_changed` 间接覆盖
- **Search query**：会泄露用户搜的关键词
- **Translation 实时切换**：会产生大量噪声，看 `recording_started` 的 translationMode 分布就够
- **Sidebar 点击**：纯导航，autocapture 已经覆盖（PostHog 自动 `$pageview`）
- **逐段翻译 / 选词查询**：单录音内每秒可能 N 次，先不看，等内测反馈再决定要不要加

## 加新事件的 checklist

1. 名字用 `snake_case`，动作在前（`x_done` 不是 `done_x`）
2. props 全部走上面"允许"列表 — 不允许字符串拼接 user input
3. 在本文档加一行
4. 如果是 LLM / IO 触发的失败，优先走 `bug_encountered(source=...)` 而不是新建 event — keep cardinality low
