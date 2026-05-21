# 部署清单（自托管，本地存储）

> 仓库：`https://github.com/Shinyaliu777/voice_project`
> 适用 commit：`main` 任意版本

---

## 1. 运行时

| 项 | 版本/要求 | 备注 |
| --- | --- | --- |
| **Node.js** | **20.x LTS 或 22.x LTS** | Next.js 15 要求 ≥ 18.18，生产建议 20 |
| **npm** | ≥ 10 | 锁文件是 `package-lock.json`，不要用 yarn/pnpm |
| **OS** | Linux x86_64 / arm64（容器或裸机均可） | — |
| **CPU/RAM** | 起步 **1 vCPU + 1 GB**；推荐 **2 vCPU + 2 GB** | LLM streaming + PDF 解析高峰吃内存 |
| **磁盘** | 系统盘 + **持久化数据卷**（音频 + Postgres） | 估算：每小时录音 ≈ 30 MB webm/opus |

---

## 2. 外部服务

### 2.1 PostgreSQL（必需）

- **版本**：PostgreSQL **14 ~ 17**（Prisma 6 全支持）
- **存储**：起步 1 GB，预留 10 GB（转录文本+元数据，**不含音频**）
- **连接数**：≥ 20（Prisma 默认连接池）
- **部署**：可在同一台机器上跑 `postgres:16-alpine` 容器；或托管 Neon / Supabase / RDS

### 2.2 音频/文档存储 = **本地文件系统**（推荐，已默认）

- **配置**：`STORAGE_DRIVER="local"`，文件写到 `STORAGE_LOCAL_DIR` 指定的目录
- **链路**：浏览器 → POST `/api/audio/chunk-presign`（路由签发本地 URL）→ PUT `/api/audio/upload-chunk?key=...`（路由验权后写盘）→ 完成
- **不暴露任何存储后端**：没有公共桶、没有跨域 PUT，文件路径不会被遍历（路由用 `^audio/[A-Za-z0-9_-]+/chunks/...` 正则校验 key）
- **回放**：`GET /api/audio/file/<path>` 路由 stream 文件，也走 Next.js 进程鉴权

> ⚠️ 必须挂**持久化卷**到 `STORAGE_LOCAL_DIR`。容器重启或部署滚动后这个目录不能被销毁，否则音频全丢。

### 2.3 Redis（可选）

- **作用**：仅用于多实例 live-share 广播 pub/sub。**单实例部署可以完全省掉**。
- 留空 `REDIS_URL` → 自动 fallback 到内存模式（同进程内仍可工作）
- 需要 Redis 6.2+ / 7.x

### 2.4 LLM Provider

| 服务 | 用途 | 必需 |
| --- | --- | --- |
| **Soniox** | 实时 STT + 翻译 | **必需** |
| **Google Gemini**（`gemini-2.5-flash` 推荐） | 纪要、聊天、词条提取、闪卡 | 二选一 |
| **Anthropic Claude** | 同上 | 二选一 |

---

## 3. 环境变量（生产）

`.env` 文件，**不要 commit**。星号为必填：

```bash
# ============ Postgres ============
DATABASE_URL="postgresql://voice:voice@localhost:5432/voice_project"   # *

# ============ Soniox ============
SONIOX_API_KEY=""                          # *
SONIOX_MODEL="stt-rt-v4"                   # 默认
SONIOX_TOKEN_TTL_SECONDS=600

# ============ LLM ============
GEMINI_API_KEY=""                          # * 二选一
ANTHROPIC_API_KEY=""                       # * 二选一
LLM_DEFAULT_PROVIDER="gemini"
LLM_MINUTES_MODEL="gemini-2.5-flash"
LLM_CHAT_MODEL="claude-sonnet-4-6"         # 没有 Claude key 改成 gemini-2.5-flash
LLM_TRANSLATE_MODEL="gemini-2.5-flash"
LLM_TERM_EXTRACT_MODEL="gemini-2.5-flash"
LLM_FLASHCARD_MODEL="gemini-2.5-flash"

# ============ 本地存储 ============
STORAGE_DRIVER="local"                                   # *
STORAGE_LOCAL_DIR="/var/lib/voice-project/uploads"       # * 绝对路径
STORAGE_PUBLIC_BASE="/api/audio/file"                    # 不要改

# ============ Redis（可选）============
REDIS_URL=""                               # 单实例留空即可

# ============ 上传 ============
UPLOAD_INTERVAL_MS=3000
TARGET_SAMPLE_RATE=16000

# ============ NextAuth / Auth.js v5（多用户登录）============
AUTH_SECRET=""                             # * openssl rand -base64 32
AUTH_URL="https://your.domain.com"         # 可选；trustHost: true 已写死在代码里
GOOGLE_CLIENT_ID=""                        # 可选；只配了 dev-login 时无需
GOOGLE_CLIENT_SECRET=""
ALLOW_DEV_LOGIN=""                         # 留空 = 仅 dev 环境允许 dev-login；
                                           # 设 "1" = 生产环境也允许（**不推荐**）

# ============ Phase 1 fallback（已被 NextAuth 取代，可不填）============
DEV_USER_EMAIL="prod@yourdomain.com"
DEV_USER_NAME="Admin"
ALLOW_DEV_USER_FALLBACK=""                 # 留空；设 "1" 会让未登录请求 fall
                                           # back 到 DEV_USER_EMAIL，仅用于
                                           # 老接口本地 smoke test

# ============ Server ============
PORT=3000
NODE_ENV="production"

# ============ 观测埋点（PostHog 自托管，可选）============
# 部署 PostHog 后填这两个，事件即开始上报；留空全 no-op。
# 详细部署指南：docs/posthog-deployment.md
NEXT_PUBLIC_POSTHOG_KEY=""
NEXT_PUBLIC_POSTHOG_HOST=""

# ============ Soniox 行为微调 ============
# 严格语种过滤：默认 ON（"1"）。code-switching 用户（中英混说）建议关掉：
# NEXT_PUBLIC_SONIOX_LANGUAGE_HINTS_STRICT="0"
NEXT_PUBLIC_SONIOX_LANGUAGE_HINTS_STRICT="1"

# ============ 推荐奖励（可选）============
# 每个新用户用你的邀请码注册成功 → 推荐人 +N 分钟月度录音额度。
# 默认 60 分钟；改成 "0" 关闭奖励但仍记录归属。
REFERRAL_BONUS_MINUTES="60"
```

> 关于 `AUTH_URL` / `trustHost`：Auth.js v5 默认要求请求里的 Host header
> 必须匹配 `AUTH_URL`，否则抛 `UntrustedHost` 并让所有 `/api/auth/*` 404。
> 本项目在 `auth.ts` 里直接写了 `trustHost: true`，因此 nginx 透传任意
> `Host` 都能跑通；`AUTH_URL` 可以不填（NextAuth 会从请求自取域名）。
> 若想更严格，再把 `AUTH_URL` 设成最终的 https 域名。

---

## 4. 网络要求

| 项 | 要求 |
| --- | --- |
| **入站** | HTTPS 443（建议）→ 反向代理 → Next.js :3000 |
| **WebSocket** | 浏览器直连 `wss://stt-rt.soniox.com:443`，**不经过本服务**，反向代理无需特殊配置 |
| **Server-Sent Events** | `/api/live-share/[token]`、`/api/chat`、`/api/sessions/[id]/minutes/stream` —— 反向代理**必须关 buffering**，否则字幕不实时 |
| **上传** | `/api/audio/upload-chunk` PUT，反向代理 `client_max_body_size ≥ 50m` |
| **Host header** | 反向代理必须把原 `Host` 透传给 Next.js（`proxy_set_header Host $host;`），否则 Auth.js v5 会把 `localhost:3000` 当成入口，回调链路全错 |
| **出站** | Soniox + Gemini/Claude + Postgres + (可选 Redis) 全部要通 |

### Nginx 模板

```nginx
upstream voice_app { server 127.0.0.1:3000; }

server {
    listen 443 ssl http2;
    server_name your.domain.com;

    ssl_certificate     /etc/letsencrypt/live/your.domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your.domain.com/privkey.pem;

    client_max_body_size 50m;

    # SSE / 长连接路由 —— 必须关 buffering
    location ~ ^/(api/(live-share|chat$|sessions/.+/minutes/stream)|api/audio/file) {
        proxy_pass http://voice_app;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        chunked_transfer_encoding off;
    }

    # 其他
    location / {
        proxy_pass http://voice_app;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }
}
```

---

## 5. 安装 / 构建 / 启动

```bash
# 1. clone
git clone https://github.com/Shinyaliu777/voice_project.git
cd voice_project

# 2. 装依赖
npm ci

# 3. 准备数据目录（一次性）
sudo mkdir -p /var/lib/voice-project/uploads
sudo chown -R $(whoami):$(whoami) /var/lib/voice-project
# Docker 部署改成在 compose 里 volumes 挂载

# 4. 配 env
cp .env.production.example .env
vi .env    # 填上面 §3 的值

# 5. 初始化数据库
npx prisma generate
npx prisma db push

# 6. 构建
npm run build

# 7. 启动（生产）
npm run start
```

### 后续升级

**标准流程（绝大多数 commit）：**

```bash
cd /opt/voice_project   # 或你的部署目录
git pull
npm ci                  # 严格按 lock 文件装，不要用 npm install
npx prisma generate     # Prisma Client 同步 schema 类型
npm run build           # 跑 Next.js 生产 build（含 typecheck）
# 平滑重启（任选其一）：
#   pm2 reload voice-project
#   systemctl restart voice-project
#   docker compose up -d --no-deps voice-project
```

**有 schema 变化时**（看 `git diff HEAD@{1} -- prisma/schema.prisma`）：

```bash
# 标准路径 — staging / 测试 / 新部署：
npx prisma migrate deploy   # 跑所有未应用的 migrations/*

# 生产 + 历史数据库有 drift 的情况（如本项目早期混用了 db push）：
# 用 db execute 单独 apply + 手动 mark applied，避免 reset 数据
npx prisma db execute --file prisma/migrations/<NEW_MIGRATION>/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied <NEW_MIGRATION_DIRNAME>
```

**有新增 env 变量时**：先 `git log -p ENV.md DEPLOY.md` 看新行，append 到 `.env` 再 build。今天（2026-05-21）新增 4 个，全部可选不填则禁用功能：
- `NEXT_PUBLIC_POSTHOG_KEY` + `NEXT_PUBLIC_POSTHOG_HOST` — 埋点
- `NEXT_PUBLIC_SONIOX_LANGUAGE_HINTS_STRICT` — Soniox 严格模式（默认 1，关闭设 "0"）
- `REFERRAL_BONUS_MINUTES` — 推荐奖励分钟数（默认 60）

**HMR / dev 服务不会自动看见新 schema/env**：改完一定要 `npm run build` 重新启动进程；只重 reload 不够。

**升级前必看的位置**：

- `docs/CHANGELOG-*.md` — 每天大变更的归档。今天的是 `docs/CHANGELOG-2026-05-21.md`。
- `prisma/migrations/<latest>/migration.sql` — 看新 migration 是否会动现有数据
- `git log -p --since="last deploy"` -- `.env*` `DEPLOY.md` README.md

**回滚**：`git reset --hard <prev_commit>` + `npx prisma migrate resolve --rolled-back <migration_dir>`（如果 schema 没真的有破坏性改动，schema 不回滚也常能跑）+ rebuild。

---

## 6. 启动方式（任选一个）

### A. Docker Compose（推荐，自带 Postgres）

`docker-compose.yml`：

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: voice
      POSTGRES_PASSWORD: voice
      POSTGRES_DB: voice_project
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
    restart: unless-stopped

  app:
    build: .
    depends_on: [postgres]
    env_file: .env
    environment:
      DATABASE_URL: postgresql://voice:voice@postgres:5432/voice_project
      STORAGE_LOCAL_DIR: /data/uploads
    ports:
      - "3000:3000"
    volumes:
      - ./data/uploads:/data/uploads     # ← 持久化音频
    restart: unless-stopped
```

`Dockerfile`：

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache curl
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
RUN mkdir -p /data/uploads
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://localhost:3000/api/health || exit 1
CMD ["npm", "run", "start"]
```

`.dockerignore`：

```
node_modules
.next
.git
uploads
data
*.local.*
```

### B. PM2（裸机）

```bash
npm install -g pm2
pm2 start npm --name voice-project -- run start
pm2 startup
pm2 save
```

### C. systemd

`/etc/systemd/system/voice-project.service`：

```ini
[Unit]
Description=Voice Project
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/voice_project
ExecStart=/usr/bin/npm run start
Restart=on-failure
EnvironmentFile=/opt/voice_project/.env

[Install]
WantedBy=multi-user.target
```

记得 `chown -R www-data:www-data /var/lib/voice-project/uploads` 和 `/opt/voice_project`。

---

## 7. 健康检查 + 冒烟测试

```bash
# 健康检查
curl https://your.domain.com/api/health
# 期望：200 {"ok":true,"db":"ok","redis":"skipped"|"ok"}

# 首页
curl -fsS https://your.domain.com/dashboard | head -1

# Soniox token 签发
curl -X POST https://your.domain.com/api/soniox-token \
  -H "Content-Type: application/json" -d '{}'
# 期望：200 {"token":"...","expiresAt":...}

# 创建录音 session
curl -X POST https://your.domain.com/api/transcription/sessions \
  -H "Content-Type: application/json" \
  -d '{"title":"smoke","sourceLang":"en","targetLang":"zh"}'
```

浏览器走一遍：登录页（暂无）→ 直接到 `/dashboard` → 点「新建录音」→ 允许麦克风 → 说几句话 → 看是否出转录卡片 → 停止 → 进 history → 听回放。

---

## 8. 备份

```bash
# 每天定时（cron）
pg_dump -Fc "$DATABASE_URL" > /backup/db-$(date +%F).dump
tar -czf /backup/uploads-$(date +%F).tar.gz /var/lib/voice-project/uploads
```

**两个目录必备份**：
- Postgres 数据卷
- `STORAGE_LOCAL_DIR`（音频文件）

---

## 9. 文件清单

| 文件 | 用途 | 是否要改 |
| --- | --- | --- |
| `.env` | 生产环境变量 | ✅ 填值 |
| `.env.production.example` | 模板（注意里面 R2 那段忽略，按本文 §3 来填） | 参考 |
| `package.json` | 依赖 + scripts | 不动 |
| `package-lock.json` | 锁版本 | 不动 |
| `prisma/schema.prisma` | 数据库 schema | 不动 |
| `next.config.ts` | Next 配置 | 不动 |
| `vercel.json` / `.vercelignore` | Vercel 专用 | **删掉** |
| `app/api/health/route.ts` | 健康检查 | 不动 |
| `Dockerfile` / `docker-compose.yml` | 仓库**没有**，按 §6 自己写 | ✅ 新建 |

---

## 10. 已知限制

✅ **登录已就绪（Phase 2 Wave 2.1）**：Google OAuth + dev-login（仅 dev/`ALLOW_DEV_LOGIN=1` 时可用）已经接入；middleware 守护 `/dashboard/*`、自动重定向 `/login`；每个 user 的录音 / 词条 / 对话已按 `user.id` 隔离。

⚠️ **支付链路未完成（Wave 2.2 待办）**：Plan / Subscription schema 已落库，配额校验也跑通了（120 min/月 + 20 chat/日），但 Stripe checkout + webhook 还没接，升级 Business 目前只能由 admin 手改数据库。

⚠️ **无限流**：恶意请求会跑光 LLM/STT 配额，建议给 Soniox/Gemini key 设月度上限。

⚠️ **单实例**：本地存储不支持横向扩展（多实例文件不共享）。需要扩容时再切换到 S3 兼容存储 + 共享 Redis。

⚠️ **Live-share token 永久有效**：分享出去的 `/share/live/<token>` URL 不会过期、不能撤销，泄漏 = 录音永久公开，按 API key 对待。

---

## 11. 故障排查

| 现象 | 排查 |
| --- | --- |
| 字幕不实时滚动 | 反向代理 SSE buffering 没关 |
| 音频上传失败 | 反向代理 `client_max_body_size`，存储目录权限 |
| `/api/health` 返回 503 | 看返回里 `db` / `redis` 字段哪个 down |
| 转录开始几秒后 408 | Soniox key 错或网络丢，看 Next 日志 |
| 纪要不生成 | LLM key 错 / 配额耗尽，看 `/api/sessions/[id]/minutes/stream` 返回 |
| Prisma 连接报错 | `npx prisma db pull` 测试连通性 |
| 重启后音频丢了 | `STORAGE_LOCAL_DIR` 不是持久化卷 |
| `[auth][error] UntrustedHost` + 所有路由 401 / `UnauthenticatedError` | Auth.js 拒绝当前 Host。本仓库 `auth.ts` 已写 `trustHost: true`，确认部署的代码版本里包含这一行，并重启进程；老进程不会热加载 |
| `/api/auth/session` 返回 200 但 `user: null` | `AUTH_SECRET` 改过导致旧 JWT 失效；清浏览器 cookie 重新登录即可 |
| Google 登录回到 `/api/auth/error` | Google Console 里 OAuth 客户端的「授权重定向 URI」缺 `https://your.domain.com/api/auth/callback/google` |
