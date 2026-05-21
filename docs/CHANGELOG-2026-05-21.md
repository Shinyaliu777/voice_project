# Changelog · 2026-05-21

一天集中 push 了 41 个 commit，分八大块。下面按主题归类，每条注明 commit hash + 影响面。

> 一句话总结：把"反编译过的 lecsync 实现策略"按优先级嫁接进 voice_project，同时修了一批阻塞内测的 bug。

---

## 1. 录音持久化 + 完整性（核心可靠性）

| Commit | 内容 | 文件 |
|---|---|---|
| `5938b9d` | IndexedDB chunk cache + `navigator.sendBeacon` + 启动恢复 | `lib/audio/local-cache.ts`, `lib/audio/recorder.ts`, `components/RecorderLane.tsx`, `app/api/audio/upload-chunk/route.ts` |
| `f6de272` | dashboard 检测未完成会话 → "继续录制 / 完成上传 / 丢弃" banner | `app/api/transcription/sessions/in-progress/route.ts`, `components/ResumeRecordingBanner.tsx` |
| `fa7bdaa` | 详情页"完成上传"补救按钮（finalize 失败的孤儿录音） | `components/FinalizeAudioButton.tsx` |
| `29e4f1f` | **修 Resume：时间续上 + 历史 segments 回填 + 纪要载入** | `components/Recorder.tsx` |
| `d87b096` | **修录音/转录不一致**：`/api/audio/finalize` 前先把 IDB 残余 chunks 重传干净，否则推迟 finalize | `lib/audio/recorder.ts`, `lib/audio/transcription-service.ts` |

设计模式：**三层兜底**（写盘 → sendBeacon → 启动重放）+ **finalize 前置确认**（IDB pending 必须为空才能 merge）。直接对应 SCI 角度 §1。

---

## 2. 翻译流水线（速度 + 准确）

| Commit | 内容 |
|---|---|
| `81096b4` | cloud 翻译 token 按 `startMs` 窗口匹配（不再 FIFO 队列头取，避免错位） |
| `e9506ba` | **本地翻译队列重做**：去掉 `setTimeout(350)` debounce，换 lecsync 风格 high/low 双优先级队列（low slot 只留最新 partial） |
| `cb131f5` | Soniox `language_hints_strict: true`（学 lecsync） |
| `019b10f` | `Segment` + `LiveCard` 加 `React.memo` —— transcript 历史不再每 100ms 重渲一次 |

效果：本地翻译感知延迟从 ~450ms 降到 ~100-200ms；UI 主线程从 ~60ms/帧降到 ~5ms/帧。

---

## 3. 配额 + 计费

| Commit | 内容 |
|---|---|
| `7c54d68` | in-flight 录音也算月度分钟（不只 finalized） |
| `1574649` → `6d2c3f8` | 用墙钟时间（`Session.durationMs` + `sum(AudioChunk.durationMs)`）作为分钟基准，**不**用 segment.audioEndMs（沉默不进 segments → 低估） |
| `98767ac` | `/dashboard/billing` 加 per-session audit 表 |
| `8de5796` | usage bars 真的可见 + 显示剩余 + 重置倒计时 |
| `f8819ce` | settings 各项真正生效（主题 / 字号 / lang defaults / 悬浮窗 / 桌面通知 / 内容语言） |

---

## 4. 推荐码系统（取代旧的"封闭内测门票"概念）

| Commit | 内容 |
|---|---|
| `76dc583` | 旧版：单次性邀请码 + 配额 + signIn gate（**已废弃**） |
| `6e3640f` | **重做：推荐码模型** — 一码可被任意多人用、注册永远开放、记录 invitedById |
| `8779e4b` | 邀请奖励：每个新用户用你的码注册 → 推荐人 +60 分钟（`REFERRAL_BONUS_MINUTES` env） |
| `f218417` | 安全加固：anti-enumeration 统一 404、rate limit 15/min、原子 reserve 防双 claim、prod 启动 guard（dev-login + Google 同开 = throw） |
| `e4d396c` → `e74359e` | 拆 `lib/invite.ts`（含 `node:crypto`）和 `lib/invite-format.ts`（client-safe）；中间件 Edge Runtime 改用 `crypto.getRandomValues` |

新 schema：
- `User.invitedById` + `User.referralBonusMinutes`
- `Invitation { code @unique, createdByUserId, note, isActive, expiresAt?, claimCount }`

---

## 5. 文件夹流程（修"录音放不进文件夹"）

| Commit | 内容 |
|---|---|
| `2a408cc` | history 里加"+ 新建文件夹"tile |
| `07105fb` | folder POST 接受 null color |
| `4976767` | **新建录音前选文件夹**（`RecorderFolderPicker`，记忆上次选）+ **SessionCard dropdown 移动到文件夹**（重新接回，弹窗选） |
| schema | `Folder` 加 `@@unique([userId, name])` 数据库级唯一约束 |

---

## 6. 录音引擎架构重构（部分落地，留有 cutover 未做）

| Commit | 内容 |
|---|---|
| `8ee5406` | `lib/audio/event-bus.ts` + `lib/stores/transcription-store.ts` + `lib/stores/use-transcription-event-sync.ts` — EventBus 单例 + Zustand store + 桥接 hook |
| `7c41b71` | `lib/audio/transcription-app.ts` + 6 个 plugin 骨架（persistence / minutes / live-share / idle-detection / recording-control / pip） |
| `5f17237` | **Step 1 cutover**：`TranscriptionAppProvider` 挂到 `app/(app)/layout.tsx`，桥接 hook 就位（**未消费，零行为变化**） |
| `74158d5` | 修 `checkBrowserSupport` 的 `Illegal invocation`（`prototype.audioWorklet` 改 `in` 操作符） |

**未完成**：Step 2（实际把 `components/Recorder.tsx` 切到 `useTranscriptionApp()`，删 `lib/audio/recorder.ts`）—— 老引擎仍是生产驱动。

---

## 7. 录音队列 + 直播分享 + 观测

| Commit | 内容 |
|---|---|
| `d88a6b0` | 录音队列 API：`/api/recording/{start,queue-status,release}` + `RecordingSlot` 表 + advisory_xact_lock 防 TOCTOU |
| `f218417` | 队列并发硬化：start/release/queue-status 全部走 `pg_advisory_xact_lock(hashtext(userId))` |
| `d8d57e7` | PostHog 自托管 SDK 接入：`lib/analytics.ts` + 11 个埋点（recording_started/stopped/failed、minutes_generated 等，**PII 全 0**） |
| `e5a466e` | `docs/posthog-deployment.md` — 部署指南 |

---

## 8. UX / Bug fix 杂项

| Commit | 内容 |
|---|---|
| `06e9030` + `727d320` | 暗色模式：Tailwind v4 `@custom-variant dark` + dashboard shell / folder / session-card 配色 |
| `b733ae6` | minutes 拆 live (incremental) vs final (post-recording) 两套字段 |
| `d180075` | session title 不再用 `new Date().toLocaleString()` 污染 title 列；前端检测旧格式 fallback 到 createdAt |
| `2ce0baf` | Recorder hoist 到 layout（in-tab 导航不再中断录音） |
| `829b47a` | live-share viewer scroll-lock |
| `3ddded7` | utterances 按 audio startMs 排序、悬浮字幕缓存上限 50 |
| `8081525` | mobile-friendly app shell |
| `ac407ce` | 5 个 P1/P2 bug 一次修：ShareDialog 死链、TranscriptView 缺 lang prop、SessionCard 死项、audio 下载扩展名、Folder 重名 409 |
| `25281fc` | `lib/audio-url.ts` 抽出去，7 处调用收口 |

---

## 数据库迁移（今天 push 的 4 个）

| Migration | 内容 |
|---|---|
| `20260521000000_add_recording_slot` | `RecordingSlot` 表 + `User.maxConcurrentRecordings` |
| `20260521010000_invite_system` | `Invitation` 表（旧版门票模型）+ `User.{invitationsRemaining,invitedById}` + `Folder` 唯一约束 |
| `20260521020000_invite_referral_rework` | 删旧的 status/claimedAt/claimedByUserId/invitationsRemaining，加 `Invitation.{isActive,claimCount}` |
| `20260521030000_referral_bonus` | `User.referralBonusMinutes` |

---

## 新增环境变量

```bash
# PostHog 客户端埋点（不设则全 no-op）
NEXT_PUBLIC_POSTHOG_KEY=""
NEXT_PUBLIC_POSTHOG_HOST=""

# Soniox 严格语种过滤（默认 1；code-switching 用户可设 0）
NEXT_PUBLIC_SONIOX_LANGUAGE_HINTS_STRICT="1"

# 邀请奖励分钟数（默认 60；改成 0 关闭奖励）
REFERRAL_BONUS_MINUTES="60"
```

---

## 内测前剩余 backlog

按重要性：

1. **Recorder.tsx hard cutover** — Step 2，把老 `lib/audio/recorder.ts` 退役换成新 `TranscriptionApp`。骨架已就位但未消费。
2. **直播分享 push transport** — `app/api/live-share/[token]/route.ts` 已经是 SSE，工作正常。优化方向：服务端 Redis pub/sub for multi-instance。
3. **录音队列客户端接入** — 服务端 API 完整，`recording-control` plugin 是 stub，需要在 `Recorder.tsx` 加 polling + 排队 UI。
4. **Stripe 计费** —— Wave 2.2，pending。

---

## 不该再回滚的（架构 invariant）

- `Session.durationMs` 含义：**wall-clock 录音秒数**（包含沉默），不是 segment.audioEndMs。
- 邀请码：**可重复使用** + **可选**，不是稀缺资源。
- finalize 必须在 IDB pending = 0 时才能跑（否则音频缺段）。
- 不能在 dev-login 同 prod Google OAuth 同时打开（auth.ts 启动 guard 会 throw）。
