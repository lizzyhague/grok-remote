# 部署说明

后端只监听 `127.0.0.1`，HTTPS 入口是独立的一层，两个端口不要求相同。先把本地后端跑
通，再配入口。

真实令牌和主机路径不提交。`config/projects.json`、`deploy/grok-remote.env`、
`deploy/*.local` 都已被 `.gitignore` 排除。

## 1. 准备

服务由**已经安装并登录 Grok 的 Unix 用户**运行：Grok 从该用户的 `~/.grok` 读登录状态，
应用把自己的状态写进 `~/.grok-remote`，附件也要访问同一用户下的 socket。

在该用户的登录环境中核验（要求 Node.js 24 以上，且 `grok` 能真的用起来）：

```bash
id -un; id -gn; printf '%s\n' "$HOME"
node --version
command -v node; command -v grok
grok --version
```

## 2. 装代码和配置

```bash
git clone https://github.com/lizzyhague/grok-remote.git
cd grok-remote
npm ci --include=dev
npm run typecheck && npm test

cp config/projects.example.json config/projects.json
cp deploy/grok-remote.env.example deploy/grok-remote.env
chmod 600 config/projects.json deploy/grok-remote.env
openssl rand -hex 32
```

编辑 `config/projects.json`，把示例根目录换成本机实际目录：

```json
{ "roots": [ { "id": "projects", "path": "/absolute/path/to/projects" } ] }
```

网页里可选的项目，是每个根目录下的第一层文件夹。

编辑 `deploy/grok-remote.env`，至少填四项：

| 变量 | 填什么 |
| --- | --- |
| `GROK_REMOTE_TOKEN` | 上面 `openssl` 生成的随机值，至少 32 字符 |
| `GROK_REMOTE_PORT` | 未占用的回环端口（不设置时默认 3000） |
| `GROK_REMOTE_PROJECTS_CONFIG` | `config/projects.json` 的绝对路径 |
| `GROK_BIN` | `command -v grok` 返回的绝对路径 |

`GROK_REMOTE_ALLOWED_ORIGINS` 通常留空；只有反向代理不保留 `Host` /
`X-Forwarded-Host` 时才填完整 Origin。

## 3a. Linux + systemd

```bash
cp deploy/grok-remote.service.example deploy/grok-remote.service.local
```

替换本地副本里的占位符：`__RUN_USER__`、`__RUN_GROUP__`、`__RUN_HOME__`、`__APP_DIR__`
（仓库根目录）、`__ENV_FILE__`、`__NODE_BIN__`、`__RUNTIME_PATH__`（含 Node 和 Grok 的
完整 PATH）。确认没有漏替换：

```bash
grep -n '__[A-Z_]*__' deploy/grok-remote.service.local   # 应无输出
sudo install -m 0644 deploy/grok-remote.service.local /etc/systemd/system/grok-remote.service
sudo systemctl daemon-reload
sudo systemctl enable --now grok-remote.service
curl --fail --show-error http://127.0.0.1:3000/healthz
```

## 3b. macOS + launchd

用系统级 LaunchDaemon，服务不依赖图形登录；`UserName` 仍是上面那个已登录 Grok 的普通
用户。

```bash
cp deploy/com.example.grok-remote.plist.example deploy/com.example.grok-remote.plist.local
mkdir -p "$HOME/Library/Logs/grok-remote" && chmod 700 "$HOME/Library/Logs/grok-remote"
```

占位符比 systemd 多两个：`__SERVICE_LABEL__`（唯一 launchd label）和 `__LOG_DIR__`。
文件名、plist 里的 `Label` 和 `launchctl` 命令三者必须一致。

```bash
plutil -lint deploy/com.example.grok-remote.plist.local
grep -n '__[A-Z_]*__' deploy/com.example.grok-remote.plist.local   # 应无输出
sudo install -o root -g wheel -m 0644 \
  deploy/com.example.grok-remote.plist.local \
  /Library/LaunchDaemons/com.example.grok-remote.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.example.grok-remote.plist
sudo launchctl kickstart -k system/com.example.grok-remote
curl --fail --show-error http://127.0.0.1:3000/healthz
```

需要代理时，把 `HTTPS_PROXY` 等写进 `deploy/grok-remote.env`，并用 `NO_PROXY` 保持
`127.0.0.1`、`localhost` 和私网入口直连。

健康检查不过就不要往下配入口。

## 4. HTTPS 入口

Tailscale Serve（只暴露给 tailnet，端口按本机实际情况选）：

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3000
tailscale serve status
```

然后从另一台 tailnet 设备打开该地址登录，发一条测试消息。用别的反向代理也一样：
Node 只监听回环，代理要正确转发 WebSocket 和上传请求。

## 5. 附件（可选）

附件走独立项目 [`ai-remote-upload`](https://github.com/lizzyhague/ai-remote-upload)，
必须与本服务同一个 Unix 用户，socket 权限 0600。安装、启动和多实例部署都按那个仓库
的说明，不要从 Codex Remote 或本仓库取得服务代码。

`AI_REMOTE_UPLOAD_SOCKET` 要与共享服务一致，默认
`~/.local/share/ai-remote/upload.sock`。共享服务不存在时纯文本功能照常，只有附件会
明确失败。更新或停止 Grok Remote 时，不要捎带更新、停止或重启上传服务。
