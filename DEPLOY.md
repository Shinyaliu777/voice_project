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

# ============ Phase 1 单用户 ============
DEV_USER_EMAIL="prod@yourdomain.com"
DEV_USER_NAME="Admin"

# ============ Server ============
PORT=3000
NODE_ENV="production"
```

---

## 4. 网络要求

| 项 | 要求 |
| --- | --- |
| **入站** | HTTPS 443（建议）→ 反向代理 → Next.js :3000 |
| **WebSocket** | 浏览器直连 `wss://stt-rt.soniox.com:443`，**不经过本服务**，反向代理无需特殊配置 |
| **Server-Sent Events** | `/api/live-share/[token]`、`/api/chat`、`/api/sessions/[id]/minutes/stream` —— 反向代理**必须关 buffering**，否则字幕不实时 |
| **上传** | `/api/audio/upload-chunk` PUT，反向代理 `client_max_body_size ≥ 50m` |
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

后续升级：

```bash
git pull
npm ci
npx prisma generate
npx prisma db push       # 如果 schema 变了
npm run build
# 平滑重启进程（pm2 reload / systemd restart / docker compose up -d）
```

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

## 10. 已知限制（Phase 1）

⚠️ **绝不能直接公网暴露**：
- 当前**无登录系统**，所有访问者共享 `DEV_USER_EMAIL` 这一个账号
- 反向代理那一层加一个 HTTP Basic Auth / Cloudflare Access / Tailscale 内网，限制访问
- Phase 2 接入 Clerk 后再开放

⚠️ **无限流**：恶意请求会跑光 LLM/STT 配额，建议给 Soniox/Gemini key 设月度上限。

⚠️ **单实例**：本地存储不支持横向扩展（多实例文件不共享）。需要扩容时再切换到 S3 兼容存储 + 共享 Redis。

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
