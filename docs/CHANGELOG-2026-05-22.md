# Changelog · 2026-05-22

一天的小爆发：管理后台 + 兑换码 + 流水。两个生产部署 bug fix。

> 一句话总结：把 lecsync 那个「订阅与账单」对话框里的兑换码 / 流水模块抄过来 + 自己长出来一套用户管理系统（lecsync 没有 admin UI，那是我们额外加的）。

---

## 1. 部署 bugfix（凌晨先修了 prod 起不来）

| Commit | 内容 | 影响面 |
|---|---|---|
| `9752a9f` | **`server.ts` 绑 0.0.0.0 by default**：之前用 `process.env.HOSTNAME`，Linux shell 会自动设成机器名（"contabo-centos"），Node 试图绑到这个名字 → 要么 DNS miss，要么只绑到 127.0.0.1，nginx → 127.0.0.1:3000 看脸 | 运维 reported；prod 起不来 |
| `fe49867` | **文件夹 picker 永远弹**：之前零文件夹时点 mic 直接开录，新用户从来没机会发现文件夹存在（"好像没有文件夹逻辑" 报告） | UX |
| `7561e87` | **middleware gate `/admin`**：原本只 gate `/dashboard`，未登录访问 `/admin` 会冲进 `(app)` layout 里的 `getDevUser()` 然后 throw → 500。补上 `/admin` 一起 gate | UX |

---

## 2. 管理后台（新功能）

新增路由 `/admin`，**单页 tabbed 控制台**。访问权限通过 `ADMIN_EMAILS` env 或 `User.isAdmin` 列。

| Commit | 模块 | 文件 |
|---|---|---|
| `735c190` | `lib/admin.ts` + `lib/admin-route.ts` | env + DB 双路 admin gate，`withAdmin()` 包装器映射 401/403 |
| `735c190` | `app/api/admin/users/route.ts` + `[id]/route.ts` + `[id]/grant/route.ts` | 用户列表（分页 + 搜索）、详情、加/减分钟、admin/suspend toggle |
| `735c190` | `app/api/admin/codes/route.ts` + `[id]/revoke/route.ts` | 兑换码列表、新建、停用 |
| `735c190` | `components/admin/AdminConsole.tsx` + `AdminUsersTab.tsx` + `AdminCodesTab.tsx` | 单页 tabbed UI，操作直接调对应 API + 乐观更新 |

**「用户」标签**：
- 表格 + 搜索（email / name 模糊匹配）
- 「分钟」按钮 → 对话框输入数字 + 原因（"内测补偿" / "退款" 之类）→ 加或减
- 盾牌按钮 → admin toggle（不能改自己 → button disabled）
- 人头按钮 → suspend toggle（同上）

**「兑换码」标签**：
- 「新建」对话框：分钟数 + 使用次数（1 次或多次）+ 前缀 + 备注 → 生成 `GIFT-XXXX-YYYY`
- 生成后弹绿色卡片显示码 + 复制按钮（提醒"现在复制，别错过"）
- 已发出的能「停用」，已经领过的不影响

---

## 3. 用户侧：`/dashboard/billing` 扩展（抄 lecsync）

对照 lecsync 截图里的「订阅与账单」对话框，新增两块卡片：

| Commit | 模块 | 文件 |
|---|---|---|
| `735c190` | **兑换码输入卡片** | `components/RedeemCodeCard.tsx` |
| `735c190` | **历史交易流水**（折叠卡片） | `components/TransactionHistory.tsx` |
| `735c190` | `app/api/me/redeem/route.ts` + `transactions/route.ts` + `billing/route.ts` | 兑换 / 流水分页 / 一次性账单摘要 |

兑换码输入框接受 dash-separated 或不分（`GIFT-AB12-CD34` 或 `GIFTAB12CD34` 都行），自动 canonicalize。成功后 `router.refresh()` 让服务端组件重读余额。

流水卡片是懒加载的：点开才发请求，每页 30 条，再按「加载更多」翻页。

---

## 4. Schema + 流水不变式

| Commit | 内容 |
|---|---|
| `735c190` | migration `20260522000000_admin_redemption_ledger` |

**User 加 3 列**：
- `bonusMinutes Int @default(0)` — 持久累加（兑换码 + 管理员补偿），不随月份清零
- `isAdmin Boolean` — 后台权限
- `isSuspended Boolean` — 软封禁（保留历史，禁止新开录音）

**3 张新表**：

```
RedemptionCode (code, minutes, maxUses, usedCount, expiresAt, note, isActive, createdById)
Redemption    (codeId, userId, minutesGranted, redeemedAt)  -- unique(codeId, userId)
MinuteTransaction (delta, kind, description, metadata, balanceAfter)  -- 索引 (userId, createdAt desc)
```

**核心不变式**（手工保护）：

```
SUM(MinuteTransaction.delta) WHERE userId = U   ==   User.bonusMinutes
```

所有改 `bonusMinutes` 的入口（兑换、管理员补偿、未来的 Stripe）都强制走 `lib/billing.ts:recordMinuteChange`，里面用 `prisma.$transaction` 把 user.update + tx.create 包成原子。手写 SQL 改 bonusMinutes 会破坏不变式，**别这么干**。

`Redemption_codeId_userId_key` 唯一约束防止同一用户重复兑换同一个码。两个不同用户同时抢兜码靠 `usedCount` 的事务原子递增 + maxUses 检查序列化。

---

## 5. 录音/Soniox 加封禁 gate

| Commit | 内容 | 文件 |
|---|---|---|
| `735c190` | `requireActiveUserId()` 新 helper：`requireUserId()` + 检查 `isSuspended` | `lib/dev-user.ts` |
| `735c190` | `/api/soniox-token` 切换到 `requireActiveUserId`，suspended 用户 403 | `app/api/soniox-token/route.ts` |
| `735c190` | `/api/recording/start` 同上 | `app/api/recording/start/route.ts` |

只 gate 这两个 chokepoint：拿不到 Soniox token + 拿不到 recording slot 就开不了新录音。读历史 / 看会话不受限——封禁是软封禁。

---

## 6. 部署文档

| Commit | 内容 |
|---|---|
| `3f01fcc` | `.env.example` + `.env.production.example` 加 `ADMIN_EMAILS` 段 |
| `b1fbc65` | `DEPLOY.md` 加 2026-05-22 升级要点段 + sanity-check 命令 + 回滚 SQL |

---

## 7. Owner email 安置（晚间小折腾）

凌晨试了两版才落地，记一下决策过程：

| Commit | 方案 | 状态 |
|---|---|---|
| `df141cb` | 在 `lib/admin.ts` 硬编码 `OWNER_EMAILS = ["shinyaliu777@gmail.com"]` | 撤回 |
| `596663f` | 新建**提交到 git 的** `.env.production` 文件，里面写死 `ADMIN_EMAILS="shinyaliu777@gmail.com"` | **采用** |

**为什么撤回硬编码**：邮箱出现在源码里，一旦仓库开源 / 卖项目 / 拉合作者就跟着走。配置该归配置，不该混代码。

**最终设计 — Next.js 标准 env 分层**：

```
.env.production.local   ← gitignored，运维放秘密（AUTH_SECRET / API keys / DB pwd）
.env.production         ← 提交到 git，非敏感公开默认（ADMIN_EMAILS 在这）
.env                    ← gitignored，本地 dev 用
```

`.local` 优先级最高，覆盖 `.env.production`。所以：
- **所有者**邮箱跟着 `git pull` 自动上 prod，运维零额外动作
- **加新 admin** 不动 git：运维写 `.env.production.local` 覆盖即可
- **秘密**永远不进 git

`lib/admin.ts` 现在只看 `ADMIN_EMAILS` env + `User.isAdmin` DB 列两条路径，没有硬编码 fallback。

`DEPLOY.md §6` 的 2026-05-22 升级段也同步成新模型，不再让运维 `echo ADMIN_EMAILS >> .env`。

---

## 8. 待办（明天起步）

- **Stripe 真支付**：lecsync 那个 dialog 的「立即订阅」+「时长叠加包」按钮还是 placeholder。Wave 2.2。
- **用户详情页 `/admin/users/[id]`**：API 已写完，UI 暂时跳过；目前点用户没详情页，只能在表格里操作。
- **兑换码导出 CSV** + **流水导出 CSV**：批量发码 / 对账场景。
- **Step 2 架构重构**：TranscriptionApp/Provider 还没真接管录音，Step 1 完成但 Step 2 deferred。
- **真用户跑通**：邀请码 + 兑换码 + 录音 + 翻译 + live-share，建议明天起来在 prod 上完整跑一遍 happy path。
