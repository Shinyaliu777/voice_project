# SCI 可写角度（voice_project）

> 系统类期刊/会议（USENIX ATC、EuroSys、NSDI、OSDI、MobiSys、UbiComp、CSCW、CHI）
> 教育技术类（IEEE TLT, Computers & Education, CALL）
> Web/前端（WWW、Web Conf）
> 这份是从 2026-05-21 这天的工作里挑出**有学术价值**的点。

---

## 1. **三层音频持久化 ("write-through-IDB-then-network")** — 最适合 systems 期刊

**问题**：实时语音转录类 web app 的核心可靠性挑战是 ——用户录到一半关 tab、浏览器崩、网络抖动 —— 浏览器端如何**零数据丢失**。传统做法是把 chunks 直接 PUT 到对象存储；网络断开就丢。

**我们的方案（去 lecsync 反编译验证过、加了几个 lecsync 没做的环节）**：

```
MediaRecorder ondataavailable
        │
        ├─ Layer 1: storeChunk(IndexedDB)   ← BEFORE network
        ├─ Layer 2: presign+PUT+chunk-record (normal upload pipeline)
        └─ Layer 3: track lastInFlightChunk for sendBeacon
                       │
                       ▼
                window.pagehide → navigator.sendBeacon(POST FormData)
                       │
                       ▼
                Next mount → cleanupOldChunks() + replay getAllPendingChunks()
```

**新颖性**：
- **finalize precondition**：`/api/audio/finalize` 前必须 `getPendingChunks(sessionId).length === 0`，否则把 session 留在 `uploading` 状态等下次启动恢复。这一步**lecsync 也有**（叫 `triggerMerge`），但学术 systems 文章里没人系统地写过这种"客户端 IDB 作为可靠性 staging area"的设计模式。
- **量化生存率**：3 秒 chunk 间隔 × 一小时录音 = ~1200 chunks。模拟 tab close at random point：
  - 无 IDB：丢平均 ~1.5 chunk × 3s = ~4.5s 音频
  - 有 IDB 但无 sendBeacon：丢 ~0.5s（in-flight 那个）
  - 三层全开：丢 ≤ ~50ms（仅 MediaRecorder onpagehide 之前 100ms 内的样本）

**写作切口**：
- 比对 5 个开源实时转录 web app（otter.ai/fireflies/lecsync/我们/...）的丢失率
- 提出一个 generalized framework："durability staircase for browser-side streaming media"
- 实现成本（IDB quota、storage I/O 开销）vs 数据保留率的 trade-off 曲线

**关键代码**：
- `lib/audio/local-cache.ts` — IDB AudioLocalCache 实现
- `lib/audio/recorder.ts` ondataavailable 三层流水
- `app/api/audio/upload-chunk/route.ts` 双模式（PUT presigned + POST FormData）
- `components/RecorderLane.tsx` 启动恢复
- finalize gate 在 `lib/audio/recorder.ts` `flushPendingChunksFromCache()`

---

## 2. **lecsync-style 单槽翻译队列 vs 传统 debounce** — 适合 HCI / 前端

**问题**：on-device 实时翻译（Chrome Translator API / Apple Translate）每次 100-300ms。如果用 `setTimeout(N)` 来防抖动，N 必须 ≥ 单次翻译耗时才能避免颠簸 → 用户最少要等 N+100ms 才能看到第一段译文。

**我们的方案**：单槽 "latest-partial-wins" 队列：

```ts
class TranslationQueue {
  highPriorityQueue: Job[] = [];     // finalized segments — FIFO
  lowPrioritySlot: Job | null;        // partials — single slot, replace

  enqueue(job) {
    if (job.priority === "high") this.highPriorityQueue.push(job);
    else this.lowPrioritySlot = job;  // REPLACE, drop previous
    this.processNext();                // no setTimeout, just fire
  }

  async processNext() {
    if (this.isProcessing || !this.translator) return;
    const next = this.highPriorityQueue.shift() ?? this.lowPrioritySlot;
    if (!next) return;
    this.lowPrioritySlot = null;
    this.isProcessing = true;
    const translated = await this.translator.translate(next.text);
    this.handlers.onResult(next, translated);
    this.isProcessing = false;
    this.processNext();   // drain
  }
}
```

**关键洞察**：
- **没有 setTimeout** — API 本身的耗时就是节流间隔
- **partial 单槽** — 新 partial 进来时如果上一个还没翻完，直接覆盖；旧的 partial 译文本来也就要被新的覆盖，浪费了也无所谓
- **优先级**：finalized 永远先于 partial 翻 → 用户切换说话人时新句子立刻翻

**实测**（CHANGELOG 里的数据）：
- 旧版（setTimeout 350）：端到端感知延迟 ~450ms（350 + ~100 翻译）
- 新版：~100-200ms（仅翻译延迟）
- **3-5× 提速**，零代码复杂度增加（其实更简单）

**写作切口**：
- Compare with `lodash.debounce` / `requestIdleCallback` / `requestAnimationFrame` patterns
- 在实时字幕、IM、协同编辑等"频繁 partial update"场景的可推广性
- 与传统流量整形（token bucket、leaky bucket）的关系 — 我们是 "API-driven natural shaping"

**关键代码**：
- `lib/audio/translation-queue.ts`（commit `e9506ba`）
- `lib/audio/recorder.ts` 中 `scheduleLiveTranslate` 使用 queue 的方式

---

## 3. **录音/转录一致性 gate** — adapter pattern for distributed state

**问题**：实时转录 web app 有**两条独立**的服务端写路径：
- 转录文本 — 走 Soniox WS → server-side persist
- 音频块 — 走 chunked HTTP upload → object storage

这两条路径在客户端层面**没有事务保证**。某个 chunk-record 失败但转录没丢 → 用户看到完整文字但播放音频中间缺一段（"录音和转录不一致"）。

**我们的方案**：finalize 前**强制对账**：

```ts
async stop() {
  // ...
  await this.chunkUploadQueue;             // wait in-memory queue
  const pending = await cache.getPendingChunks(sessionId);
  if (pending.length > 0) {
    // Retry through the multipart endpoint (server upserts on
    // (sessionId, chunkIndex) — idempotent)
    for (const row of pending) await this.retry(row);
    if (await cache.getPendingChunks(sessionId).length > 0) {
      // Still failed — bail without finalize. Session keeps
      // status="uploading"; next-mount recovery picks it up.
      return;
    }
  }
  await fetch("/api/audio/finalize", ...);
}
```

**新颖性**：
- 用客户端 IDB **作为两路写入的同步点**（barrier）
- finalize 是 idempotent 的 mark-as-done 操作；audio 和 transcript 的 reconciliation 在 finalize 之前完成
- 失败模式优雅：session 留 "uploading"，下次启动 banner 提示用户

**写作切口**：
- 客户端 transactional patterns for split-write scenarios（PWA / offline-first）
- 与 server-side saga pattern 的对偶
- 数据丢失/不一致的可观测性（log + tag + reconciliation metrics）

**关键代码**：
- `lib/audio/recorder.ts` `flushPendingChunksFromCache()`（commit `d87b096`）

---

## 4. **多租户并发录音公平调度** — systems / 资源管理

**问题**：单用户开多 tab → 多份 Soniox WS 连接 → 计费爆炸 / 服务端资源浪费。

**我们的方案**：服务端 advisory_xact_lock 保护的 slot table：

```sql
CREATE TABLE "RecordingSlot" (
  id text PRIMARY KEY,
  userId text,
  sessionId text NULL,
  status text,           -- "active" / "queued" / "released"
  queuePosition int NULL,
  claimedAt timestamp,
  releasedAt timestamp NULL
);
CREATE INDEX ON "RecordingSlot"(userId, status);
```

```ts
// /api/recording/start
await prisma.$transaction(async tx => {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`;
  // ... sweep stale, count active, decide active|queued
});
```

**新颖性**：
- 用 PG advisory lock 取代 redis lua 实现 per-user 并发控制
- Stale slot sweep：active 但 Session.updatedAt > 10min → 自动 release（处理崩溃客户端）
- queued 排队 + 客户端 3s 轮询 + DELETE 取消

**写作切口**：
- 与 Stripe / Twilio 等 SaaS 的 fairness control 对比
- 单 Postgres 实例支持的最大并发率（lock contention 实测）
- 与 plan-tier 配额（per-plan max concurrent）的 composition

**关键代码**：
- `prisma/migrations/20260521000000_add_recording_slot/migration.sql`
- `app/api/recording/{start,queue-status,release}/route.ts`

---

## 5. **EventBus + Zustand store + 桥接 hook 的解耦模式** — 前端架构

**问题**：浏览器端 imperative 引擎（AudioWorklet + WebSocket + MediaRecorder）和 React UI 的双向耦合。直接 `onEvent` 回调让 UI 组件直接调引擎方法，没法 hot-swap / 没法单测 / 没法 multi-consumer。

**我们的方案**（从 lecsync 反编译里学的，加了类型化）：

```
imperative engine ────emit────► EventBus singleton
                                       │
                                       │ on{X} subscriptions
                                       ▼
                              useTranscriptionEventSync() hook
                                       │
                                       │ store.actions()
                                       ▼
                              Zustand TranscriptionStore
                                       │
                                       │ useStore(selector)
                                       ▼
                                  React UI
```

**关键设计**：
- EventBus 是 imperative-only（不依赖 React）
- Bridge hook (`useTranscriptionEventSync`) 是单一进入点，挂在 Provider 内
- Store 用 Zustand（细粒度订阅）
- 任意子组件可以 hot-swap，引擎不变

**写作切口**：
- 与传统 MVC / Redux thunks / RxJS 的对比
- 在 "streaming long-running engine + reactive UI" 场景的可推广性
- decoupling cost：types, dual maintenance

**关键代码**：
- `lib/audio/event-bus.ts`
- `lib/stores/transcription-store.ts`
- `lib/stores/use-transcription-event-sync.ts`
- `lib/audio/transcription-app-provider.tsx`

---

## 6. **教育技术 / Pedagogy 角度** — 适合 IEEE TLT / Computers & Education

**故事**：voice_project 是为**英文授课、母语非英语的学生**设计的实时转录+翻译+学习工具。能写：

- **可访问性**：实时字幕 + 双语对照 + 悬浮窗，覆盖听力受限 + 二语学习者两类需求
- **认知负荷**：translation-emphasis / source-emphasis / balanced 三档 display mode，与 Mayer's CTML 理论对应
- **post-session 学习闭环**：minutes + chat + 词汇本 + flashcards (SM-2)
- **隐私第一**：本地翻译路径（Chrome Translator API）避免内容离开浏览器
- **小样本实测**：找 10-20 名学生 A/B 测试，比对带 vs 不带工具的笔记完整度、考试成绩、自我感知压力

**写作切口**：
- 字段：CALL (Computer Assisted Language Learning), Educational Technology Research and Development
- 设计研究（Design-Based Research）方法论
- 实验：3 周 vs 3 周 control，前后测 + 课程作业评分

---

## 优先级建议

如果只能写一篇 SCI：

1. **#1 三层音频持久化** —— 最 systems-y，量化清晰，benchmark 容易设计
2. **#2 翻译队列** —— 短论文 / poster 合适，量化数据现成（450ms → 100-200ms）
3. **#6 教育技术** —— 需要拉用户做实验，工作量大但容易接受

把 #1 + #2 一起写，能合成一个 "Designing for liveness in browser-based real-time transcription tools" 的中等长度论文。

---

## 想发现的实证数据（如果走 #1 或 #2）

需要部署后跑实验收集：

| 指标 | 测量方式 | 用途 |
|---|---|---|
| Chunk 上传失败率 | server log + PostHog `chunk_upload_failed` event | 证明 IDB 必要性 |
| 平均 in-IDB-pending 时长 | IDB cleanup 时记录 createdAt - now | 量化 IDB 兜底窗口 |
| sendBeacon 成功率 | server-side: pagehide POST 到 IDB-replay 的比率 | 评估 layer 2 的实际作用 |
| Recovery 率 | 多少 session 是通过启动重传完成 finalize 的 | 评估 layer 3 |
| 翻译端到端延迟分布 | client-side mark/measure，P50/P95/P99 | 队列 vs debounce 直接对比 |
| 重渲帧数 | React DevTools Profiler trace | memo 优化前后对照 |

数据收集需要：
- 接 PostHog（已就位）
- 加几个埋点：chunk lifecycle events、translation latency mark/measure
- 1-2 周线上数据，N=30+ 用户起算
