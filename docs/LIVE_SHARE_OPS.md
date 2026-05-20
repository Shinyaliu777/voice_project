# Live-Share 运维排查清单（给服务器侧）

> 适用：voice.cyanclay.org 自托管 Linux + nginx 反代到 Next.js :3000
> 现象：viewer 看 `/share/live/<token>` 时字幕延迟大 / 漏字 / 不实时滚动

应用层（代码）这边已经做了能做的：
- host push 加 1 次自动重试，5xx 也会重试（不再静默吞）
- viewer 每 30 秒兜底从数据库重新拉一遍 segments 补漏
- viewer 默认显示 host 的翻译，不再自己再翻一遍（之前两边翻译"内容不同"的根因）

但**实时延迟大 / 不滚动**最常见的根因不在代码，是 **nginx 把 SSE 给 buffer 住了**。SSE（Server-Sent Events）是长连接 + 流式 chunked transfer，nginx 默认会缓冲，等攒到几 KB 才推给客户端，对实时字幕是致命的——字幕全堆在一起隔几秒一下子吐出来。

下面是要核对 + 修的 6 项。建议按顺序逐个验证。

---

## 1. nginx：SSE 路由必须关闭 buffering

**关键路由**（4 个都要走 no-buffer 配置）：
- `GET /api/live-share/[token]` ← viewer 的 SSE 流，**这一条最关键**
- `POST /api/sessions/[id]/minutes/stream` ← 纪要流
- `POST /api/chat` ← 聊天流
- `POST /api/lookup` ← 选词查询流

**正确配置**（参考 `DEPLOY.md` §4 nginx 模板）：

```nginx
location ~ ^/api/live-share/[^/]+$ {
    proxy_pass http://voice_app;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto https;

    # ↓↓↓ 这 4 行是 SSE 的关键 ↓↓↓
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 600s;
    chunked_transfer_encoding off;
}
```

**怎么验证 nginx 当前是否关了 buffering**：

```bash
# 在服务器上：
curl -N -H "Accept: text/event-stream" https://voice.cyanclay.org/api/live-share/<某个真实token>

# 如果配置正确：应该 1 秒内就看到 `event: joined` + `data: {...}` 输出。
# 如果配置错误：要么很久没输出，要么几秒后才一次性吐一大坨。
```

```bash
# 也可以直接查当前生效的配置：
nginx -T 2>/dev/null | grep -A 8 "live-share"
# 必须能看到 proxy_buffering off; 如果没有就是没生效
```

---

## 2. nginx：Host header 必须透传

```nginx
proxy_set_header Host $host;
```

这一行在所有 location 块里都要有。Auth.js v5 在 `auth.ts` 里写了 `trustHost: true`，意味着它信任 nginx 转过来的 Host，但前提是 nginx 真的把客户端的 Host 转过来，不是改成 `localhost:3000`。错了会导致 `/api/auth/*` 全 401，连带 `/api/live-share/[token]/push` 也 403（push handler 要 auth）。

**验证**：

```bash
curl -sI https://voice.cyanclay.org/api/health
# 看返回 200 OK + {"ok":true,"db":"ok",...}
# 401 / 502 / Untrusted Host 之类都不对
```

---

## 3. 部署是不是单实例

应用层用了内存 broadcaster（`lib/live-share/broadcaster.ts`）做 host → viewer 的事件扇出。**单实例运行没问题**；多实例的话要走 Redis pub/sub，否则一个实例上的 host push 另一个实例上的 viewer 收不到。

**验证**：

```bash
# 服务器上看进程：
ps aux | grep "next start" | grep -v grep
# 只应该出现一行（一个 Node 进程）。出现多行的话说明跑了多实例
# pm2 / systemd / docker 都要确认是单实例
```

如果**确实是多实例部署**，必须设 `REDIS_URL`：

```bash
# .env 加：
REDIS_URL="rediss://default:<password>@<host>:<port>"
# 然后重启所有 Node 进程
```

单实例就**留空** `REDIS_URL=""`，应用会自动用内存模式。

---

## 4. nginx：上传限制要 ≥ 50m

不是 live-share 直接相关，但音频上传（`/api/audio/upload-chunk`）需要：

```nginx
client_max_body_size 50m;
```

放在 `server {}` 块顶部。少了的话音频块会上传失败，间接导致 live-share 也不完整（没 audio 就没 transcript 就没 push）。

---

## 5. 后端进程是不是真的拿到新代码

每次发新 commit 后，**Node 进程必须重启**才生效。Next.js 是编译后的产物，不会热重载。

```bash
# 验证当前进程版本：
cd /opt/voice_project   # 替换成实际路径
git log -1 --oneline
# 看 commit hash 是不是最新的

# pm2 部署：
pm2 restart voice-project

# systemd 部署：
systemctl restart voice-project

# docker-compose 部署：
docker compose up -d --build app
```

特别提醒：本次修复涉及 `pushLiveShare` 加 retry + 新增 `/api/live-share/[token]/segments` 路由。**新路由需要 Next.js 重新 build**，老进程上没有这个路由，viewer 会一直 404。

---

## 6. 给 viewer 端的快速排错（在浏览器里跑）

把 share 链接发给一个 viewer，让他在浏览器 DevTools → Network 标签：

```
1. 过滤 EventStream 类型，应该看到 1 个连接到 /api/live-share/<token>，
   状态 200，pending（一直开着）。
2. 点这个请求 → EventStream 标签 → 应该实时滚出 utterance / segment 事件。
   如果数据列空白 → SSE 没真的流过来 → 多半是 nginx buffering（回去看第 1 节）。
3. 过滤 Fetch/XHR，每 30s 应该有一个 /api/live-share/<token>/segments 请求，
   200，返回 {"items":[...]}。这就是兜底刷新，正常的。
```

---

## 7. 应用层日志怎么看（万一上面都没问题）

```bash
# Next.js 进程日志（pm2 例）：
pm2 logs voice-project --lines 200

# 关注：
# - "[recorder] live_share_push_failed"  ← host 端 push 一直失败
# - 500 / 502 ←  push handler 出错
# - "Token not found"  ← share token 过期或被删了（其实不会过期，但 session
#   被删的话 share 也会失效）
```

---

## TL;DR — 优先级最高的三步

1. **核对 nginx 是否 `proxy_buffering off`** —— 90% 的延迟问题都在这
2. **核对部署是否单实例**，多实例必须 `REDIS_URL`
3. **核对发布流程是否 restart 了进程** —— 没 restart 等于代码没生效
