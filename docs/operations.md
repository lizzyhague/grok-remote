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

Node 直接跑 TypeScript，没有构建步骤。重启只影响本服务，不涉及入口、其它 Remote 或
独立的 `ai-remote-upload` 服务。更新本服务时不要重启上传服务。

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
`http-server.test.ts` 里验证返回 200。脚本和样式由服务端按内容生成 `/assets/<哈希>/`
地址，保存在 `public/.web-assets/`；只改已有文件内容不必再改 HTML 版本号或 Service
Worker 缓存名。新增静态路由或改后端代码必须重启。部署时保留 `.web-assets/`，不要清空
仍可能被已打开页面使用的旧快照。

## 排错

网页打不开，从里往外查：回环 `/healthz` 是否成功 → 服务是否 `active` → HTTPS 入口是否
转到正确的回环端口 → 防火墙、DNS 或 tailnet ACL 是否放行。

能打开但登录不了：令牌不对就核对环境文件；WebSocket 被拒就看日志里的 Origin 和
Host；页面脚本没启动就看 `boot.js`、`app.js` 和依赖资源是不是都返回 200。

联网且部署完整时，普通刷新即可加载当前页面及其对应的脚本、样式，不必关闭已安装的
PWA。手机可在聊天列表、会话列表顶部或标题栏空白处下拉刷新。页面不会因为
Service Worker 更新而自动重载。离线只能打开最近一次完整缓存的外壳，会话功能仍需联网。
