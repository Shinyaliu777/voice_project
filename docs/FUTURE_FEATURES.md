# Future features — design notes & deferred decisions

This file captures features we've researched but chose **not to build yet**,
so the rationale doesn't get lost. Each section ends with a TL;DR of what
needs to land before the feature is worth revisiting.

---

## Chat 联网搜索 (web search) — deferred

### Status
- UI: the `联网` toggle in the chat composer is **rendered but disabled**.
- Backend: no integration.

### What we learned from lecsync (2026-05-18)
Lecsync's chat backend is OpenRouter. We confirmed by extracting their
response field names (`billable_web_search_calls`, `is_byok`,
`upstream_inference_cost`, `native_tokens_reasoning`, …) which are
OpenRouter-specific to `/api/v1/generation`. Their chat send body is:

```js
{ message, sessionId, transcriptionSessionId,
  thinking: bool, webSearch: bool, modelId: string }
```

When `webSearch: true` they hit OpenRouter with `plugins: [{ id: "web" }]`
which routes through Exa (OpenRouter's bundled web-search provider).
Cost: **$4 / 1000 searches** ≈ ¥0.028/call.

### Why we're not doing this in Phase 1
1. **国内部署不通**: our prod target is a self-hosted Linux box in 国内.
   OpenRouter is hosted in the US and needs a VPN/proxy to reach reliably
   from 国内. Same problem for Exa, Tavily, Brave.
2. **不在关键路径**: voice→transcript→minutes is the core loop. Chat-vs-AI
   is secondary, and web search is secondary inside chat.
3. **价格不是阻塞**: ¥0.03/call is fine — we'd just rather wait until we
   have a user clamoring for it.

### When we revisit
- Pick a 国内 provider:
  - **Bocha 博查 AI 搜索** (https://open.bochaai.com) — ¥0.03/次, AI-optimized,
    handles 中英文, returns pre-summarized snippets. **Top pick for our setup.**
  - Tavily — better English, but US-hosted (¥0.035, free 1000/mo).
  - 智谱 GLM 自带搜索 — ¥0.03, only if we already use GLM as LLM.
  - Kimi `tools: [web_search]` — ¥0.21/次, too expensive.
- Don't take the OpenRouter route unless we move LLM hosting back to 国际.

### Implementation outline (when we pick it up)

1. **`lib/web-search/index.ts`** — new provider abstraction (mirrors the
   `lib/llm/index.ts` shape). `WebSearchProvider` interface:
   ```ts
   interface WebSearchResult { title: string; snippet: string; url: string; }
   interface WebSearchProvider {
     search(query: string, opts?: { topK?: number }): Promise<WebSearchResult[]>;
     readonly id: string;
   }
   ```
2. **`lib/web-search/bocha.ts`** — Bocha implementation. Reads
   `BOCHA_API_KEY` from env, POSTs to
   `https://api.bochaai.com/v1/web-search`. Returns top-N snippets.
3. **`app/api/chat/route.ts`** — accept `webSearch: boolean` in body. When
   true: call web-search provider with user message → format results as
   `Web search results:\n[1] {title} — {snippet} ({url})\n[2] …` → splice
   into system prompt right before the transcript section. Cite as `[N]`.
4. **`components/ChatPanel.tsx`** — remove the disabled styling on the
   `联网` button, wire it to `webSearch` state, include `webSearch` in
   the request body.
5. **Error path**: if `webSearch: true` but provider key is missing or call
   fails, surface a single toast "联网搜索暂不可用 — 已用原始模型回答" and
   continue without web context. Don't crash the chat.

### Cost ceiling
1 search per chat turn × ¥0.03 = trivial. Even at 10k turns/month it's
¥300. We control this by gating `联网` behind a paid plan if needed (the
existing free-tier dailyLimit hook).

---

## (placeholder — add more deferred features below as they come up)
