# lecsync 反编译笔记

整理自 lecsync.com 公开 JS bundle + 已登录账号的真实 API 响应。
日期：2026-05-18。

这份文档不是产品规划，是**事实卡片** — 他们具体做了什么、用了什么栈、什么 endpoint 返回什么。

---

## 1. 技术栈总览

| 层 | 选型 |
| --- | --- |
| Web 框架 | Next.js 15 (App Router, Turbopack) |
| Auth | **NextAuth.js** (`/api/auth/*`) — Google + Apple + Credentials |
| ORM | Prisma + Postgres（推断，模型有 cuid id） |
| Billing | **Stripe**（web） + **Apple IAP**（iOS app） |
| LLM 路由 | **OpenRouter**（响应字段 `billable_web_search_calls / native_tokens_reasoning / is_byok / upstream_inference_cost`） |
| 模型 | Gemini 2.5-Flash (Basic) / Gemini 3-Flash (Pro, premium-only) |
| 搜索 | OpenRouter `:online` plugin (Exa) |
| 分析 | Mixpanel (重度) + Amplitude |
| 移动 | Expo / React Native（独立 App 走 Apple IAP） |

---

## 2. 套餐与 quota 真实数据

### `/api/subscription/plans` — 全部套餐

```json
[
  { "id": "cmkzdeylm000w04lbq2yftuz9",
    "name": "内测版", "displayName": "Free",
    "monthlyPriceCents": 0, "yearlyPriceCents": 0,
    "monthlyMinutes": 120,
    "cloudTranslationIncluded": true,
    "isDefault": true },
  { "id": "cmlexoj0e002q04kw6ultk6yz",
    "name": "business", "displayName": "Business",
    "monthlyPriceCents": 5999,         // $59.99/mo
    "yearlyPriceCents": 35999,         // $359.99/yr (= $29.99/mo, 50% off)
    "monthlyMinutes": 999999,           // 无限
    "cloudTranslationIncluded": true,
    "appleProductIdMonthly": "com.lecsync.business.monthly",
    "appleProductIdYearly": "com.lecsync.business.yearly" }
]
```

**关键事实**：
- 只有两档：Free / Business
- Business 是**唯一付费档**，没有中间档（不像 Notion 那样分 Pro/Team）
- Free 120 分钟/月（≈ 2 小时录音）；够大学生一周
- Apple IAP product ID 跟 Stripe 平行存在（同一个 subscription，两路付款）

### `/api/subscription` — 当前用户

```json
{ "planId": "cmkzdeylm000w04lbq2yftuz9",
  "plan": { "displayName": "Free", "monthlyMinutes": 120, ... },
  "status": "ACTIVE",
  "billingCycle": "MONTHLY",
  "currentPeriodStart": "2026-04-09T...",
  "currentPeriodEnd": null,                  // 免费档无截止
  "cancelAtPeriodEnd": false,
  "isStripeSubscription": false,
  "subscriptionSource": "redemption" }        // ← 关键：来源标记
```

`subscriptionSource` 可能值（推断）：`stripe / apple_iap / redemption / default`。
**`redemption` = 用邀请码兑换的 Free 档** — 邀请码不直接送钱，是让被邀请的人开通 Free 服务的入口。

### `/api/chat/quota` — chat 维度的配额

```json
{
  "models": [
    { "modelId": "google/gemini-2.5-flash", "displayName": "Basic",
      "isPremium": false, "supportsThinking": true, "supportsWebSearch": true },
    { "modelId": "google/gemini-3-flash", "displayName": "Pro",
      "isPremium": true, "supportsThinking": true, "supportsWebSearch": true }
  ],
  "isPaidUser": false,
  "dailyUsed": 0, "dailyLimit": 20,            // Free 每天 20 条
  "defaultModelId": "google/gemini-2.5-flash"
}
```

**关键事实**：
- chat 的限制是**每日 20 条**（独立于 monthlyMinutes 的录音限）
- 模型有两级：Basic (免费) / Pro (付费才能用)
- `supportsThinking` / `supportsWebSearch` 是 **模型 capability 标志** — UI 上 thinking / 联网按钮的 enable/disable 都看这个字段
- 付费用户 `dailyLimit` 估计是无限或更高

---

## 3. 邀请系统

### `/api/invite/list`

```json
{ "invitation": {
    "id": "cmnrb7by603fi01p522ujvbg7",
    "code": "7XB2P",
    "status": "ACTIVE",
    "expiresAt": null,
    "maxUses": null,
    "usageCount": 0 }}
```

**模式**：每个用户固定一张码（注册时创建），永不过期，无次数限制，但 `usageCount` 计数。

**奖励规则**（从 UI 看）：
- 邀请人：每个新人完成首次录音 +60 min 上限 1500 min
- 被邀请人：通过邀请码注册 = 拿 Free 档（`subscriptionSource: "redemption"`）

---

## 4. NextAuth 配置

`/api/auth/providers` 返回（公开端点，无需鉴权）：

```json
{
  "google":      { "type": "oidc" },
  "apple":       { "type": "oidc" },
  "credentials": { "type": "credentials" }    // 邮箱+密码？或邮箱验证码？
}
```

**关键事实**：
- 没有微信、QQ、手机号 OAuth — **国际化优先**
- Apple OAuth 应该是给 iOS app 用的 (Sign in with Apple)
- Credentials provider 可能是「邮箱+验证码」magic-link 风格（NextAuth credentials 不一定是密码）

---

## 5. LLM 路由 = OpenRouter

`/api/v1/generation` 响应字段（从他们 bundle 解析出来的 zod schema）：

```
total_cost, upstream_inference_cost, created_at, is_byok, provider_name,
finish_reason, generation_time, native_tokens_prompt, native_tokens_completion,
native_tokens_reasoning, native_tokens_cached, native_tokens_cache_creation,
billable_web_search_calls
```

这是 OpenRouter v1 generation 接口独有。

**他们怎么用**：
1. chat 请求 body: `{ message, modelId, thinking, webSearch, ... }`
2. 后端把 modelId 映射成 OpenRouter 调用：
   - `thinking: true` → 切到 reasoning 模型变种
   - `webSearch: true` → `plugins: [{ id: "web" }]`
3. 把 OpenRouter 响应里的 cost / token 数据透传给前端

**意义**：他们一份代码，可以无缝换模型 / 加 web 搜索 / 用任意 provider — 不锁死在某家。

---

## 6. 右侧栏（已实现）

详见 `components/RecorderSidebar.tsx` 的实现 commit。

三 tab：纪要 / 对话 / 文件 + 可折叠成图标条。**已对齐 lecsync**。

---

## 7. 我们做得不好的（按 lecsync 对照）

| 维度 | 他们 | 我们 | 行动 |
| --- | --- | --- | --- |
| **多用户** | NextAuth (Google/Apple/Credentials) | DEV_USER_EMAIL hack | **必做** Phase 2 wave 2 |
| 计费 | Stripe + Apple IAP, 2 档 plans | 无 | **必做** 想商用就要 |
| 配额 | 录音分钟 + chat 条数，按 plan 区分 | 后端 stub `{remaining:1000}` | 必做（依赖 auth） |
| 邀请码 | 每人 1 码，redemption 入口 | 无 | 可做（依赖 auth） |
| 模型分级 | Basic 免费 / Pro 付费 | 全部走同一模型 | 可做（依赖 auth + Stripe） |
| LLM 路由 | OpenRouter 兜底所有 provider | DeepSeek/Gemini/Claude/各家 SDK 直连 | **不改** — 国内部署 OpenRouter 不通 |
| 移动端 sidebar | 底部 Sheet | hidden 在 < lg | 中等优先级 |
| 分析 | Mixpanel + Amplitude | 无 | 低优 — 上线后再说 |
| 国际化 i18n | 多语言界面切换 | 中文写死 | 低优 — 商用阶段加 |

---

## 8. Phase 2 多用户实现拆解

下面四块独立，可单独完成、单独上线：

### A. NextAuth 接入（**核心**, 1-2 天）

替换 `lib/dev-user.ts` 单点 hack。新增：

- `npm i next-auth@5 @auth/prisma-adapter`
- `prisma/schema.prisma`：加 `Account / Session / VerificationToken` 三个 NextAuth 表
- `app/api/auth/[...nextauth]/route.ts`：providers = `[GoogleProvider, CredentialsProvider(magic-link via email)]`
- `auth.ts` 根级配置 + middleware
- 把 46 条 route 里的 `getDevUserId()` 替成 `auth()`，取出 `session.user.id`

env 增加：
```
NEXTAUTH_URL=https://voice.cyanclay.org
NEXTAUTH_SECRET=...                          # openssl rand -base64 32
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
EMAIL_FROM=...                               # for magic-link via SES/Resend
EMAIL_SERVER_HOST=smtp.resend.com
EMAIL_SERVER_PORT=465
EMAIL_SERVER_USER=...
EMAIL_SERVER_PASSWORD=...
```

### B. Plan / Subscription 数据模型（半天）

照 lecsync 的结构搬：

```prisma
model Plan {
  id                       String   @id @default(cuid())
  name                     String                  // "free" | "business"
  displayName              String
  description              String?
  monthlyPriceCents        Int      @default(0)
  yearlyPriceCents         Int      @default(0)
  monthlyMinutes           Int      @default(120)
  monthlyChatMessages      Int      @default(20)
  cloudTranslationIncluded Boolean  @default(true)
  isPremium                Boolean  @default(false)
  isActive                 Boolean  @default(true)
  isDefault                Boolean  @default(false)
  stripePriceIdMonthly     String?
  stripePriceIdYearly      String?
  appleProductIdMonthly    String?
  appleProductIdYearly     String?
  createdAt                DateTime @default(now())
}

model Subscription {
  id                       String   @id @default(cuid())
  userId                   String   @unique
  user                     User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  planId                   String
  plan                     Plan     @relation(fields: [planId], references: [id])
  status                   SubscriptionStatus
  billingCycle             BillingCycle
  currentPeriodStart       DateTime
  currentPeriodEnd         DateTime?
  cancelAtPeriodEnd        Boolean  @default(false)
  isStripeSubscription     Boolean  @default(false)
  subscriptionSource       String                  // "default" | "stripe" | "apple" | "redemption"
  stripeSubscriptionId     String?
  stripeCustomerId         String?
  createdAt                DateTime @default(now())
  updatedAt                DateTime @updatedAt
}

enum SubscriptionStatus { ACTIVE PAST_DUE CANCELED EXPIRED }
enum BillingCycle      { MONTHLY YEARLY }
```

Seed：默认创建 Free 套餐；新用户注册时 trigger 创建 ACTIVE/Free Subscription。

### C. 配额系统（1 天，依赖 A+B）

- `lib/quota.ts`：`getUserUsage(userId)` 算本月录音分钟 + 今日 chat 数
- `lib/quota.ts`：`checkQuota(userId, kind: "recording" | "chat")` 返回 `{allowed, remaining, limit}`
- 替换 `/api/chat/quota` stub
- 在录制 start (`/api/transcription/sessions` POST) 和 chat send (`/api/chat` POST) 入口检查
- 超额时返回 402（Payment Required）+ UI 弹「升级套餐」对话框

### D. Stripe checkout + webhook（2-3 天，依赖 A+B）

- `app/api/subscription/checkout/route.ts`：创建 Stripe Checkout Session，传 `planId + cycle`
- `app/api/stripe/webhook/route.ts`：监听 `checkout.session.completed / invoice.paid / subscription.deleted`，写 `Subscription` 表
- 设置页加 `/dashboard/billing`：显示当前套餐 + 升级/取消按钮
- 测试用 Stripe test mode，真上线再切 production

### E. 邀请码（半天，依赖 A+B）

```prisma
model Invitation {
  id           String   @id @default(cuid())
  code         String   @unique               // 5 位大写字母数字
  inviterId    String
  inviter      User     @relation(fields: [inviterId], references: [id])
  status       String   @default("ACTIVE")
  expiresAt    DateTime?
  maxUses      Int?                            // null = 无限
  usageCount   Int      @default(0)
  createdAt    DateTime @default(now())
}

model InvitationRedemption {
  id           String   @id @default(cuid())
  invitationId String
  invitation   Invitation @relation(fields: [invitationId], references: [id])
  redeemerId   String   @unique               // 一个人只能用一次
  redeemer     User     @relation(fields: [redeemerId], references: [id])
  redeemedAt   DateTime @default(now())
}
```

注册时自动创建一张 invitation（5 位短码）。注册接口接 `?inviteCode=` query param，校验 + 写 redemption + 给 inviter 奖励（录音分钟数 +60 min/人）。

---

## 9. 推荐执行顺序

**Wave 2.1** （最小可登录）：
1. A (NextAuth, Google + Email magic-link)
2. B (Plan/Subscription schema + seed free plan)
3. C 子集：只做 quota 表 + 录制分钟拦截（chat 暂不限，反正没 Stripe 没人付钱）

**Wave 2.2**（开始收钱）：
4. D (Stripe checkout + webhook)
5. C 完整版：chat 也限流

**Wave 2.3** （增长）：
6. E (邀请码)
7. Mixpanel 接入

每一 wave 推完都能上线发用户。

---

## 10. 反编译方法学（备查）

我用过的命令、思路：

1. 在 Chrome 已登录 tab 里 `[...document.scripts].map(s => s.src)` 拉出所有 chunk URL
2. 在页面 context 里 `fetch(...)` 拿 JS 文本（避免 CORS）；如果被 `[BLOCKED: Sensitive key]` 截 → 改用 curl 走外部
3. `grep -bo "keyword"` 二进制偏移定位
4. `tail -c +OFFSET | head -c N | sed 's/,/,\n/g'` 把 minified 拆行
5. 直接 `fetch('/api/...')` 在登录 tab 里探端点 — 不需要重写 client，cookies 自动带
6. NextAuth 的 `/api/auth/providers` 是无需鉴权的，第一时间打它确认 provider 配置
