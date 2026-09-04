# macOS 部署说明

本文补充 macOS + launchd 的部署方式。通用的运行用户、代码、依赖、项目白名单和环境
变量准备仍按 [`deployment.md`](deployment.md) 第 1 至 4 节执行；不要在两份文档之间复制
真实令牌。

Grok Remote 始终只监听 `127.0.0.1`。本说明使用系统级 LaunchDaemon，使服务不依赖
图形登录而随系统启动；LaunchDaemon 仍通过 `UserName` 以已经安装并登录 Grok 的普通
用户运行。

## 1. 核验运行用户和路径

在计划运行服务的用户登录环境中执行：

```bash
id -un
id -gn
printf '%s\n' "$HOME"
command -v node
node --version
command -v grok
grok version
grok models
```

要求 Node.js 24 或更新版本，且 `grok models` 能使用该用户已有的登录状态返回模型列表。
不要把另一个 macOS 账户的 `~/.grok`、钥匙串或其它凭据复制给运行用户。

## 2. 安装依赖并准备配置

在仓库根目录执行：

```bash
npm ci --include=dev
npm run typecheck
npm test
cp config/projects.example.json config/projects.json
chmod 600 config/projects.json
cp deploy/grok-remote.env.example deploy/grok-remote.env
chmod 600 deploy/grok-remote.env
openssl rand -hex 32
```

编辑 `config/projects.json` 和 `deploy/grok-remote.env`。至少填写：

- `GROK_REMOTE_TOKEN`：最后一条命令生成的随机值；
- `GROK_REMOTE_PORT`：未占用的回环端口；
- `GROK_REMOTE_PROJECTS_CONFIG`：`config/projects.json` 的绝对路径；
- `GROK_BIN`：`command -v grok` 返回的真实可执行文件路径。

`npm ci --include=dev` 显式安装类型检查和测试所需依赖，即使调用环境已经设置
`NODE_ENV=production` 也不会漏装。

如果 Grok 或其它外部请求需要代理，把该服务专用的 `HTTP_PROXY`、`HTTPS_PROXY`、
`ALL_PROXY` 和对应小写变量写入未跟踪的 `deploy/grok-remote.env`，并用 `NO_PROXY` 与
`no_proxy` 保持 `127.0.0.1`、`localhost`、本地域名和私网入口直连。不要为此给普通登录
shell 设置整账号的通用代理。

## 3. 生成 LaunchDaemon plist

复制模板：

```bash
cp deploy/com.example.grok-remote.plist.example deploy/com.example.grok-remote.plist.local
mkdir -p "$HOME/Library/Logs/grok-remote"
chmod 700 "$HOME/Library/Logs/grok-remote"
```

编辑本地副本并替换全部占位符：

| 占位符 | 填写内容 |
| --- | --- |
| `__SERVICE_LABEL__` | 唯一的 launchd label，例如 `com.example.grok-remote` |
| `__RUN_USER__` | `id -un` 的结果 |
| `__RUN_GROUP__` | `id -gn` 的结果 |
| `__RUN_HOME__` | 运行用户的 HOME 绝对路径 |
| `__APP_DIR__` | 仓库根目录绝对路径 |
| `__ENV_FILE__` | `deploy/grok-remote.env` 的绝对路径 |
| `__NODE_BIN__` | `command -v node` 的绝对路径 |
| `__RUNTIME_PATH__` | 包含 Node、Grok 和系统命令目录的完整 `PATH` |
| `__LOG_DIR__` | 上一步创建的日志目录绝对路径 |

模板通过 Node.js 的 `--env-file` 读取权限为 `0600` 的服务环境文件，真实 WebSocket 令牌
和代理参数不会进入权限为 `0644` 的 plist。

先检查 plist 和遗留占位符：

```bash
plutil -lint deploy/com.example.grok-remote.plist.local
grep -n '__[A-Z_]*__' deploy/com.example.grok-remote.plist.local
```

第二条命令应没有输出。若仍有占位符，不要安装 plist。

## 4. 安装并启动 LaunchDaemon

以下操作修改系统服务，必须由管理员执行。先把 plist 文件名替换为实际 label；文件名、
plist 内的 `Label` 和后续 `launchctl` 命令必须完全一致：

```bash
sudo install -o root -g wheel -m 0644 \
  deploy/com.example.grok-remote.plist.local \
  /Library/LaunchDaemons/com.example.grok-remote.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.example.grok-remote.plist
sudo launchctl kickstart -k system/com.example.grok-remote
```

先验证本地后端，其中端口应与环境文件一致：

```bash
curl --fail --show-error http://127.0.0.1:3000/healthz
sudo launchctl print system/com.example.grok-remote
```

启动失败时查看运行用户日志目录下的 `grok-remote.log` 和
`grok-remote.error.log`。不要在健康检查失败时继续配置 Tailscale Serve 或其它入口。

## 5. 更新和重启

在仓库目录中以代码所有者身份更新并验证：

```bash
git pull --ff-only
npm ci --include=dev
npm run typecheck
npm test
```

测试通过后由管理员重启并再次做回环健康检查：

```bash
sudo launchctl kickstart -k system/com.example.grok-remote
curl --fail --show-error http://127.0.0.1:3000/healthz
```

普通应用更新不应修改 Tailscale Serve、主机网络或其它 Remote。若 Grok Remote 正在承载
当前控制连接，应先准备断线、重连和验收步骤，再执行重启。
