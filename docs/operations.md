# 运维说明

## 更新

后端和前端作为一个版本切换：服务在开始监听前读定整套前端，之后工作树里的改动不会
交给正在运行的进程，重启才整体换新。所以可以在运行中的工作树里拉取和验证，但只有
验证通过才重启。在仓库目录里以代码所有者身份更新并验证：

```bash
previous=$(git rev-parse HEAD)
git pull --ff-only
npm ci --include=dev
npm run typecheck && npm test
```

验证失败时不要重启，先把工作树退回原版本，免得进程被意外拉起时装上半升级的代码：

```bash
git reset --hard "$previous"
npm ci --include=dev
```

验证通过后重启。Linux：

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
Worker 缓存名。任何前端或后端改动都要重启才生效。

`.web-assets/` 由服务自己管理：每次启动保留当前版本和最近两次启动用过的旧版本，更早的
自动删除，已打开的旧页面在接下来两次发布内仍能取到资源。部署时不要手工清空这个目录。
浏览器的离线缓存同样只保留当前离线页和上一套离线页的资源。

## 排错

网页打不开，从里往外查：回环 `/healthz` 是否成功 → 服务是否 `active` → HTTPS 入口是否
转到正确的回环端口 → 防火墙、DNS 或 tailnet ACL 是否放行。

能打开但登录不了：令牌不对就核对环境文件；WebSocket 被拒就看日志里的 Origin 和
Host；页面脚本没启动就看 `boot.js`、`app.js` 和依赖资源是不是都返回 200。

联网且部署完整时，普通刷新即可加载当前页面及其对应的脚本、样式，不必关闭已安装的
PWA。手机可在聊天列表、会话列表顶部或标题栏空白处下拉刷新。页面不会因为
Service Worker 更新而自动重载。离线只能打开最近一次完整缓存的外壳，会话功能仍需联网。
