# 部署清单（非 Vercel）

把这份文档发给运维同学。覆盖运行时、外部服务、环境变量、构建命令、网络要求。

> 仓库：`https://github.com/Shinyaliu777/voice_project`
> 当前分支：`main` （commit `ffe82ba` 之后均可）

---

## 1. 运行时

| 项 | 版本/要求 | 备注 |
| --- | --- | --- |
| **Node.js** | **20.x LTS 或 22.x LTS**（开发用的 24.x 也行；最低 18 不再支持 `node:`-style 内置） | Next.js 15 要求 ≥ 18.18，**生产建议 20** |
| **npm** | ≥ 10 | 不要用 yarn / pnpm（lockfile 是 `package-lock.json`） |
| **OS** | Linux x86_64 / arm64（容器或裸机均可） | 已在 macOS 上开发，Linux 同样无依赖问题 |
| **CPU/RAM** | 单实例最小 **1 vCPU + 1 GB**；推荐 **2 vCPU + 2 GB** | LLM streaming + PDF 解析高峰时吃内存 |

---

## 2. 外部服务（4 个）

### 2.1 PostgreSQL（必需）

- **版本**：**PostgreSQL 14 ~ 17**（Prisma 6 全支持）
- **存储**：起步 1 GB，预留 10 GB（转录文本 + 元数据）
- **连接数**：≥ 20（Prisma 默认连接池大小）
- **可选托管**：Neon / Supabase / Railway / RDS / 自建均可
- **必须**支持 `pg_trgm` 扩展用于全文搜索（如 PG 14+ 默认就有）

### 2.2 对象存储（S3 兼容，必需）

- **协议**：S3 v4 签名
- **桶名**：自定（示例 `voice-project`）
- **CORS 配置**（必须允许浏览器直接 PUT 上传）：
  ```json
  [{
    "AllowedOrigins": ["https://<你的域名>"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }]
  ```
- **公共访问**：音频回放需要 `S3_PUBLIC_BASE` 是浏览器可访问的 URL（公共桶 / CloudFront / R2 公开域名 / MinIO 反向代理均可）
- **可选托管**：Cloudflare R2（推荐，免出网费） / AWS S3 / Backblaze B2 / MinIO 自建

### 2.3 Redis（可选但强烈建议）

- **版本**：**Redis 6.2+ 或 7.x**
- **协议**：标准 RESP（不是 HTTP）—— 用 `ioredis` 通过 `rediss://` (TLS) 或 `redis://` 连
- **用途**：多实例 live-share 广播 pub/sub
- **不配置后果**：单实例可跑（内存 fallback），但**水平扩 / 多 pod 时**主播推送会丢
- **可选托管**：Upstash (TCP 模式) / Redis Cloud / Railway / 自建

### 2.4 LLM Provider（至少 1 个）

| 服务 | 用途 | 必需？ |
| --- | --- | --- |
| **Soniox** | 实时 STT + 翻译 | **必需** |
| **Google Gemini** (`gemini-2.5-flash` 推荐) | 纪要、聊天、词条提取、闪卡推荐 | 二选一即可 |
| **Anthropic Claude** | 同上 | 二选一即可 |

只要二者填一个，`LLM_DEFAULT_PROVIDER` 指向它即可。

---

## 3. 环境变量（生产）

按重要程度排序，星号(*) 为必填：

```bash
# ============ Postgres ============
DATABASE_URL="postgresql://user:pass@host:5432/voice_project?sslmode=require"  # *

# ============ Soniox STT ============
SONIOX_API_KEY=""                          # *
SONIOX_MODEL="stt-rt-v4"                   # 默认即可
SONIOX_TOKEN_TTL_SECONDS=600               # 默认 10 分钟

# ============ LLM ============
GEMINI_API_KEY=""                          # * (二选一)
ANTHROPIC_API_KEY=""                       # * (二选一)
LLM_DEFAULT_PROVIDER="gemini"              # "gemini" | "anthropic"
LLM_MINUTES_MODEL="gemini-2.5-flash"
LLM_CHAT_MODEL="claude-sonnet-4-6"         # 若没填 Claude key，可改为 gemini-2.5-flash
LLM_TRANSLATE_MODEL="gemini-2.5-flash"
LLM_TERM_EXTRACT_MODEL="gemini-2.5-flash"
LLM_FLASHCARD_MODEL="gemini-2.5-flash"

# ============ 对象存储 ============
STORAGE_DRIVER="s3"                        # * 生产必须 "s3"
S3_ENDPOINT="https://s3.example.com"       # *
S3_REGION="auto"                           # R2/MinIO 用 "auto"，AWS 用 "us-east-1" 等
S3_BUCKET="voice-project"                  # *
S3_ACCESS_KEY_ID=""                        # *
S3_SECRET_ACCESS_KEY=""                    # *
S3_PUBLIC_BASE="https://bucket.example.com"  # * 浏览器播放音频用，必须可公开 GET

# ============ Redis (可选但建议) ============
REDIS_URL="rediss://default:password@host:6379"   # 留空走内存 fallback

# ============ 上传 ============
UPLOAD_INTERVAL_MS=3000                    # MediaRecorder 切片间隔，默认 3s
TARGET_SAMPLE_RATE=16000                   # Soniox 固定 16k，别动

# ============ Phase 1 单用户模式 ============
DEV_USER_EMAIL="prod@yourdomain.com"       # 当前所有数据归这个账号；Phase 2 加 Clerk 后失效
DEV_USER_NAME="Admin"

# ============ Server ============
PORT=3000                                  # 监听端口，默认 3000
NODE_ENV="production"
```

完整模板见仓库根 `.env.production.example`。

---

## 4. 网络与协议要求

| 项 | 要求 |
| --- | --- |
| **入站 HTTP/HTTPS** | 443（生产强烈建议 TLS） |
| **WebSocket** | 浏览器直接连 Soniox `wss://stt-rt.soniox.com:443`，**不经过本服务**，无需打洞 |
| **Server-Sent Events (SSE)** | 本服务 `/api/live-share/[token]`、`/api/chat`、`/api/sessions/[id]/minutes/stream` —— **反向代理必须关闭 buffering** |
| **直传 PUT** | 浏览器 → 对象存储签名 URL，需要 CORS（见 2.2） |
| **出站** | Soniox / Gemini / Anthropic / Redis / Postgres / S3 —— **全部 outbound 必通** |

**Nginx 关 buffering 示例**（如果反向代理）：

```nginx
location /api/ {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    # SSE 必须
    proxy_buffering off;
    proxy_cache off;
    proxy_set_header Connection '';
    chunked_transfer_encoding off;
    proxy_read_timeout 600s;
}

location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
}

client_max_body_size 50m;   # 音频 chunk 上传需要
```

---

## 5. 构建 / 启动 / 数据库迁移

### 一次性初始化

```bash
git clone https://github.com/Shinyaliu777/voice_project.git
cd voice_project
npm ci                                     # 严格按 lockfile 装依赖
cp .env.production.example .env             # 填上面 §3 的真实值
npx prisma generate                         # 生成 Prisma client
npx prisma db push                          # 把 schema 推到 Postgres（首次/无迁移）
                                            # 或：npx prisma migrate deploy 如果用 migrate
```

### 编译生产构建

```bash
npm run build
```

构建产物在 `.next/`。需要保留：`.next/`、`node_modules/`、`prisma/`、`public/`、`package.json`、`package-lock.json`、`next.config.ts`。

### 启动

```bash
npm run start                              # 默认监听 0.0.0.0:3000
# 或自定义 PORT： PORT=8080 npm run start
```

### 后续部署（拉新版本）

```bash
git pull
npm ci
npx prisma generate
npx prisma db push                          # 如有 schema 变更
npm run build
# 平滑重启（建议 pm2 / systemd / k8s rolling）
```

### 健康检查

```bash
curl https://<域名>/api/health
# 200 {"ok":true,"db":"ok","redis":"ok"}
# 503 {...}  → DB 或 Redis 挂了
```

---

## 6. 部署方式三选一

### 选项 A：Docker

仓库**目前没有 Dockerfile**（之前打算上 Vercel）—— 让朋友用这个模板：

```dockerfile
# Dockerfile
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
RUN apk add --no-cache curl                # for healthcheck
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
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

### 选项 B：PM2（裸机直跑）

```bash
npm install -g pm2
pm2 start npm --name voice-project -- run start
pm2 startup
pm2 save
```

### 选项 C：systemd

```ini
# /etc/systemd/system/voice-project.service
[Unit]
Description=Voice Project
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/voice_project
ExecStart=/usr/bin/npm run start
Restart=on-failure
EnvironmentFile=/opt/voice_project/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

---

## 7. 文件清单（朋友只看这些）

| 文件 | 用途 | 朋友需要改？ |
| --- | --- | --- |
| `.env` | 生产环境变量（**不要 commit**） | ✅ 必须填 |
| `.env.production.example` | 模板 | 仅参考 |
| `package.json` | 依赖清单 + npm scripts | 不动 |
| `package-lock.json` | 锁定版本 | 不动（`npm ci` 用） |
| `prisma/schema.prisma` | 数据库 schema | 不动 |
| `next.config.ts` | Next.js 配置 | 不动 |
| `vercel.json` | 仅 Vercel 用 | **删掉**或忽略 |
| `.github/workflows/ci.yml` | GitHub Actions CI | 不动（部署侧无关） |
| `app/api/health/route.ts` | 健康检查端点 | 不动，用来监控 |

可以删的：`vercel.json`、`.vercelignore`、`DEPLOY.md`（这文件）

---

## 8. 上线后冒烟测试

```bash
# 1. 首页能开
curl -fsS https://<域名>/dashboard | head -1

# 2. 健康检查全绿
curl -fsS https://<域名>/api/health

# 3. 创建 session（dev user 自动 upsert）
curl -X POST https://<域名>/api/transcription/sessions \
  -H "Content-Type: application/json" \
  -d '{"title":"smoke","sourceLang":"en","targetLang":"zh"}'

# 4. Soniox 临时 token 能签发
curl -X POST https://<域名>/api/soniox-token \
  -H "Content-Type: application/json" -d '{}'

# 5. live-share 公开页可达（即使无 token 也应 404 而不是 500）
curl -fsS -o /dev/null -w "%{http_code}\n" https://<域名>/share/live/nonexistent
```

---

## 9. 已知限制（Phase 1）

- **没有登录**：所有访问者共享同一个 `DEV_USER_EMAIL` 的数据。**绝不能直接暴露公网**。建议在反向代理上加一层 HTTP Basic Auth 或 Cloudflare Access 顶住，等 Phase 2 上 Clerk 后再开放。
- **没有计费**：所有 LLM/STT 用量都直接打你的 API key。建议给 Soniox/Gemini key 设置 monthly cap。
- **没有限流**：恶意请求会跑光 API 配额。生产前在 nginx 加 `limit_req_zone`。

---

## 10. 兜底联系

部署遇到问题先看：
- `app/api/health/route.ts` 的返回结果
- 容器/进程日志：搜 `Failed to`、`prisma`、`ioredis`、`AbortError`
- Prisma 链接问题：直接 `npx prisma db pull` 跑一下看是否能连
- S3 链接问题：`aws s3 ls --endpoint-url=$S3_ENDPOINT s3://$S3_BUCKET --profile=...`
