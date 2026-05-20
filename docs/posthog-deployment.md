# PostHog 自托管部署指南

voice_project 的客户端埋点（`lib/analytics.ts`）发到 PostHog。生产环境用
**自托管** PostHog（不是 PostHog Cloud），原因：

- **国内访问**：app.posthog.com 与 us.i.posthog.com 在国内不稳定，eu.i.posthog.com 同样需要绕。自托管放在与 voice.cyanclay.org 相邻的 Linux 主机上，零墙
- **隐私**：录音类应用对用户行为数据要求高，所有 PII 都不会离开自己的机房
- **成本**：内测期数据量小，自托管比 SaaS 起步成本低

下面是单机最小可用部署。两台机的高可用方案在最末尾。

## 系统要求

- Linux x86_64（Debian 12 / Ubuntu 22.04 LTS 推荐）
- 4 GB RAM（最小，PostHog 文档建议 8 GB+）
- 20 GB 磁盘起步（事件按月增长 ~50 MB / 1k 活跃用户）
- Docker + Docker Compose v2
- 域名：`ph.cyanclay.org`（推荐子域，独立证书）

```sh
# 安装 docker（Debian/Ubuntu）
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER  # 重新登录以生效
docker compose version  # 应该是 v2.x+
```

## 一、起 PostHog 容器

PostHog 官方一键安装脚本会拉 `posthog/posthog-ce` 镜像 + ClickHouse + Kafka + Postgres + Redis + MinIO，并自动写 docker-compose.yml + .env。

```sh
mkdir -p /opt/posthog
cd /opt/posthog

# PostHog 官方一键安装
curl -L https://posthog.com/docs/self-host/configure/scaling-howto | head -1  # 仅检查访问可达
git clone https://github.com/PostHog/posthog.git
cd posthog
git checkout release-1.43.0  # 最新稳定 release，按实际查

# 复制 env 模板
cp .env.example .env
```

编辑 `/opt/posthog/posthog/.env`，至少改这几项：

```
SITE_URL=https://ph.cyanclay.org
SECRET_KEY=<随机 50 字符，openssl rand -hex 25>
DATABASE_URL=postgres://posthog:<密码>@postgres:5432/posthog
CLICKHOUSE_PASSWORD=<另一个随机字符串>

# 关掉 Anonymous Telemetry（向 PostHog 反馈）
DISABLE_SECURE_SSL_REDIRECT=0
IS_BEHIND_PROXY=1   # 因为我们走 nginx

# 邮件（用于发送密码重置 — 内测期可以先用 SMTP relay）
EMAIL_HOST=<smtp 主机>
EMAIL_HOST_USER=<smtp 用户>
EMAIL_HOST_PASSWORD=<smtp 密码>
EMAIL_PORT=587
EMAIL_DEFAULT_FROM=noreply@cyanclay.org
```

启动：

```sh
cd /opt/posthog/posthog
docker compose up -d
docker compose logs -f web  # 等到 "Listening at: http://0.0.0.0:8000" 出现
```

第一次启动会迁移 ClickHouse + Postgres，需要 2-5 分钟。

## 二、nginx 反代到 ph.cyanclay.org

PostHog 容器暴露 8000 端口（Web/UI + 事件接收都在这个端口）。nginx 上加一个新的 server block：

```nginx
# /etc/nginx/sites-available/ph.cyanclay.org
server {
    listen 80;
    server_name ph.cyanclay.org;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ph.cyanclay.org;

    ssl_certificate     /etc/letsencrypt/live/ph.cyanclay.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ph.cyanclay.org/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;

    # 事件 payload 可能比较大（session replay 关掉就还好），调大限制
    client_max_body_size 20M;

    # PostHog 的 /e/ 和 /capture/ 是事件接收端点，对延迟敏感
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_read_timeout 90s;
        proxy_send_timeout 90s;
    }

    # 静态资源不要透传，让 PostHog 自己缓存
    location ~ ^/static/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_cache_valid 200 1d;
    }
}
```

申请证书 + 启用：

```sh
sudo certbot --nginx -d ph.cyanclay.org
sudo ln -s /etc/nginx/sites-available/ph.cyanclay.org /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 三、PostHog 后台创建项目 + 拿 key

1. 浏览器访问 `https://ph.cyanclay.org`
2. 第一次访问会让你建管理员账号
3. 登录后 → "New Project" → 取名 `voice-project`
4. 进入 Project Settings → "Project API Key"，复制 `phc_...` 串

## 四、配 voice_project 环境变量

在 voice_project 的 `.env`（生产是 `.env.production` 或服务器上的真实 env 文件）加：

```
NEXT_PUBLIC_POSTHOG_KEY=phc_xxxxxxxxxxxxxxxxxxxxxxxx
NEXT_PUBLIC_POSTHOG_HOST=https://ph.cyanclay.org
```

⚠️ 这两个变量是 `NEXT_PUBLIC_` 前缀，**会被打到客户端 bundle 里**，所以
`phc_...` 这个 key 必须是 "Project API Key"（只能写入，不能读后台），而不
是 "Personal API Key"（管理员级别）。PostHog 的 capture key 设计就是公开
可见的。

重新 build + 重启 Next.js：

```sh
cd /var/www/voice_project
npm run build
pm2 restart voice-project  # 或 systemctl restart voice-project，按你的 process manager
```

## 五、验证

1. 开浏览器访问 voice.cyanclay.org，登录
2. 浏览器 DevTools → Network → 看有没有 POST 到 `ph.cyanclay.org/e/`
3. PostHog 后台 → Live → 应该能看到 `identify` + `recording_started` 等事件流过

如果 Network 里没看到请求：
- `NEXT_PUBLIC_POSTHOG_KEY` 没注入？（build 时变量必须存在）→ `printenv | grep POSTHOG` 检查
- CDN loader 被屏蔽？检查 `https://ph.cyanclay.org/static/array.js` 能不能加载

## 六、维护清单

- **磁盘监控**：ClickHouse 数据会持续增长。设 cron 报警当 `/var/lib/docker/volumes/posthog_clickhouse-data` > 80% 时通知
- **备份**：每周 `docker compose exec postgres pg_dump posthog > /backup/posthog-$(date +%F).sql.gz`，ClickHouse 数据用 `clickhouse-backup` 工具
- **升级**：PostHog release 周期约 2 周。升级前先在 staging 跑：`git fetch && git checkout release-X.Y.Z && docker compose pull && docker compose up -d`
- **session replay**：默认关闭（隐私敏感）。后续需要时在 Project Settings → "Session recording" 打开，并通知用户

## 七、关掉埋点（紧急情况）

如果发现埋点出问题导致客户端卡顿，临时关掉的最快方式：

```sh
# 在 voice_project 的 .env.production 删掉 NEXT_PUBLIC_POSTHOG_KEY
# 重新 build + restart
npm run build && pm2 restart voice-project
```

`lib/analytics.ts` 在 key 缺失时全部 no-op，不会报错也不会拖慢页面。

## 八、双机 / 高可用（后续）

内测期单机够用。规模上去后：

- **应用层**：PostHog Web 容器拆出来跑两份，前面挂 nginx upstream 负载均衡
- **数据层**：ClickHouse / Kafka / Postgres 走 PostHog 官方的 K8s helm chart 部署
- **日志聚合**：用 Loki + Grafana 看 PostHog 自身的运行日志

参考：[PostHog Scaling Guide](https://posthog.com/docs/self-host/configure/scaling-howto)

---

## 事件清单（对照 `docs/analytics-events.md`）

部署完成后这些事件应该开始出现：

| 事件 | 触发位置 |
|---|---|
| `identify(userId)` | layout 加载（components/AnalyticsBoot.tsx） |
| `recording_started` | Recorder.tsx → handleStart |
| `recording_stopped` | Recorder.tsx → handleStop |
| `recording_failed` | Recorder.tsx catch |
| `chunk_upload_failed` | Recorder.tsx onEvent error path |
| `minutes_generated` | GenerateMinutesButton 200 |
| `minutes_failed` | GenerateMinutesButton catch |
| `share_link_created` | LiveShareDialog mint 200 |
| `share_link_opened` | viewer.tsx mount |
| `settings_changed` | SettingsDialog.update |
| `bug_encountered` | toast.error in chat/export/recorder paths |

PII 全部不会进 PostHog（email、转录文本、minutes 内容、姓名都不发）—— 完整规则在 `docs/analytics-events.md`。
