# 运维说明

## 更新

在仓库目录里以代码所有者身份更新并验证，通过之后再重启：

```bash
git pull --ff-only
npm ci --include=dev
npm run typecheck && npm test
```

Linux：

```bash
sudo systemctl restart grok-remote.service
curl --fail --show-error http://127.0.0.1:3000/healthz
```

macOS：

```bash
sudo launchctl kickstart -k system/<你的 label>
curl --fail --show-error http://127.0.0.1:3000/healthz
```

Node 直接跑 TypeScript，没有构建步骤。重启只影响本服务，不涉及入口和其它 Remote。

## 看状态和日志

Linux：

```bash
systemctl status grok-remote.service --no-pager
journalctl -u grok-remote.service -n 50 --no-pager
```

macOS：看运行用户日志目录下的 `grok-remote.log` 和 `grok-remote.error.log`。

## 新增前端文件

`public/` 不是目录服务，是白名单。新增或改名前端文件时，要在
`src/server/http-server.ts` 的 `STATIC_FILES` 里登记 URL、文件名和 Content-Type，并在
`http-server.test.ts` 里验证返回 200，否则浏览器只会拿到 404。只改已有文件的内容不用
重启，新增静态路由或改后端代码必须重启。

## 排错

网页打不开，从里往外查：回环 `/healthz` 是否成功 → 服务是否 `active` → HTTPS 入口是否
转到正确的回环端口 → 防火墙、DNS 或 tailnet ACL 是否放行。

能打开但登录不了：令牌不对就核对环境文件；WebSocket 被拒就看日志里的 Origin 和
Host；页面脚本没启动就看 `boot.js`、`app.js` 和依赖资源是不是都返回 200。
