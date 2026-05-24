# Magic Link 邮件登录配置文档

> 目的：让微信/QQ/钉钉等 in-app webview 用户能登录（Google OAuth 在这些环境被 `disallowed_useragent` 拦截）
>
> 状态（2026-05-23）：**代码已 ship（commit `80408cc`），env + DNS 未配置**
>
> 完成本文档全部步骤约需 25 分钟。

---

## 已完成（代码侧）

| 项 | 文件 | 备注 |
|---|---|---|
| NextAuth Resend provider 接入 | `auth.ts` | 当 `RESEND_API_KEY` 存在时自动启用 |
| 启动保护扩展 | `auth.ts` | dev-login + Google/Resend 同时在 prod 会拒启 |
| `/login` UI 加邮箱登录主推位 | `app/login/LoginForm.tsx` | 在 Google 上方；提交后显示"已发送链接到 xxx" |
| In-app 浏览器提示文案更新 | `components/InAppBrowserNotice.tsx` | 主推邮箱登录 + 备选切浏览器 |
| env 模板补全 | `.env.example`, `.env.production.example` | `RESEND_API_KEY` + `EMAIL_FROM` |
| `VerificationToken` 表 | `prisma/schema.prisma` (line 92) | NextAuth 标准表，**已存在不用迁移** |

---

## 待配置（操作侧）

### Step 1：Resend 账号 + API Key（5 分钟）

1. 访问 https://resend.com
2. 用 GitHub 登入 or 邮箱注册（免费）
3. Dashboard → API Keys → Create API Key
   - Name: `voice-project-prod`
   - Permission: Full access
   - Domain: All domains
4. 复制 key（`re_` 开头，**只显示一次**）→ 暂存进 1password / 笔记

### Step 2：验证发件域名（10 分钟 + DNS 传播 5-15 分钟）

> 不验证域名也能用 `onboarding@resend.dev` 作为发件人，但**只能发到注册 Resend 时验证的那个邮箱**。投生产必须验证自家域名。

1. Resend Dashboard → Domains → Add Domain → 输 `voice.cyanclay.org`
2. Resend 给出 **3 条 DNS 记录**（DKIM × 2 + SPF × 1，TXT 类型）
3. 去 `cyanclay.org` 的 DNS 控制面板（Cloudflare / 阿里云 / Namecheap / 等）
4. 加这 3 条 TXT 记录到 `voice.cyanclay.org` 子域
5. 回 Resend 点 "Verify Domain"
6. 等 5-15 分钟，状态变 `Verified` 即可

### Step 3：生产 env 写入（5 分钟）

在生产服务器 `/opt/voice_project/.env.production.local`（gitignored）加：

```bash
RESEND_API_KEY="re_xxxxxxxxxxxx"          # Step 1 拿到的
EMAIL_FROM="Voice Project <hi@voice.cyanclay.org>"
```

> 备用：还没验证域名前，先 `EMAIL_FROM="Voice Project <onboarding@resend.dev>"`，只能发到你注册 Resend 那个邮箱，但能测通流程。

### Step 4：部署（运维 5 分钟）

```bash
cd /opt/voice_project
git pull origin main        # 拉到 commit 80408cc 之后
npm ci
npm run build
sudo systemctl restart voice-project   # 或你的重启命令
```

> 也带上昨天的 Google OAuth in-app browser 检测组件（commit `38ee029`），一次部署同时生效。

---

## 验证（部署后）

### 测试 1：真浏览器（Safari / Chrome）
1. 打开 https://voice.cyanclay.org/login
2. 顶部应能看到「邮箱登录（任何浏览器都能用）」表单
3. 下方分割线「或」
4. Google 按钮（次要样式 outline）

### 测试 2：邮箱发送
1. 输入你注册 Resend 的邮箱 → 点「发送链接」
2. 应看到绿色提示「已发送登录链接到 you@…」
3. 去邮箱（10 秒内应到）
4. 邮件主题：`Sign in to <yourdomain>` 或类似
5. 点击邮件里的链接 → 自动跳回 voice.cyanclay.org → 自动登录完成

### 测试 3：in-app 浏览器（微信）
1. 把 https://voice.cyanclay.org/login 链接发到自己微信
2. 微信里点开链接
3. 应看到顶部邮箱登录 + 中间黄色提示「在 微信 内无法用 Google 登录，请改用上面邮箱登录」
4. 输邮箱发送 → 切到邮件 app 点链接 → 自动用系统浏览器打开 → 登录成功

---

## 故障排查

### 没收到邮件
1. 检查 Resend dashboard → Emails 看是否发出（如果在那里 = Resend 发了，问题在邮箱端）
2. 检查垃圾邮件夹
3. 看服务器日志 `journalctl -u voice-project -n 100`
4. 检查 `EMAIL_FROM` 的域名是否在 Resend 上 `Verified` 状态

### 点击链接报 "Sign in error"
1. 链接 10 分钟过期，重新发一次
2. 检查 `NEXTAUTH_URL` 是否正确（应是 `https://voice.cyanclay.org`，**不能**是 localhost）
3. 检查服务器时间同步（NTP），偏差太大会导致 token 验证失败

### Boot guard 拒启动
错误信息：`[auth] Refusing to boot: ALLOW_DEV_LOGIN=1 with a real auth provider...`
- 关掉 `ALLOW_DEV_LOGIN` 或注释掉 `RESEND_API_KEY` 二选一
- 生产**不该**开 dev-login（任何人输任何邮箱就能登）

---

## 月成本

| 用量 | 成本 |
|---|---|
| < 3000 封/月 | **¥0**（Resend 免费 tier） |
| 3000-50000 封/月 | $20/月 (Resend Pro) |
| > 50000 封/月 | $80+/月 |

内测/小规模上线**长期 ¥0**。

---

## 相关 commit

- `80408cc` — Magic-link via Resend 全套实现
- `38ee029` — In-app browser 检测组件
- `7561e87` — middleware 加 /admin gate
- `fe49867` — 文件夹 picker 永远弹（昨天）
- `9752a9f` — server.ts 绑 0.0.0.0（昨天）

均在 `main` 分支上，pull 一次全要。
