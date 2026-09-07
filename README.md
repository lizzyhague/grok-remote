# Grok Remote

单用户、自托管 PWA。在手机或电脑上控制 Linux 或 macOS 主机上的 Grok Build CLI。

消息在浏览器里编完再发。后端接受后可以关掉页面，本轮由按需 Worker（`grok agent stdio`）继续跑。

> 不是官方产品，也不是多人账户。部署者是唯一受信任的使用者。

本应用与 Codex Remote 独立部署并使用不同入口，UI 布局、视觉和通用交互保持同步；Grok 能力差异单独适配。通用部署边界见 [`docs/deployment.md`](docs/deployment.md)。

## 数据路径

```text
浏览器 PWA
  → HTTPS 入口（Tailscale Serve 或其它反向代理）
  → 127.0.0.1:<GROK_REMOTE_PORT> 上的 Grok Remote Node 后端
  → Unix socket 上的共享 ai-remote-upload（仅附件）
  → 仅在需要执行时：grok agent stdio（ACP JSON-RPC）
  → Grok 原生会话 ~/.grok/sessions/<按工作目录分组>/<session-id>/
```

服务只绑 `127.0.0.1`。浏览器只看见为本 PWA 准备的小协议，不会直接碰到 ACP、文件系统或终端。

## 要求

- Linux 或 macOS 主机
- Node.js 24 或更新版本
- 已安装并登录 `grok`
- 一份项目白名单 `projects.json`（可与其它 Remote 共用，用 `GROK_REMOTE_PROJECTS_CONFIG` 指向）
- 使用附件时，需要与 Grok Remote 同一 Unix 账号运行的共享 `ai-remote-upload` 服务

部署说明分为通用准备、[Linux + systemd](docs/deployment.md) 和
[macOS + launchd](docs/deployment-macos.md)。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `GROK_REMOTE_TOKEN` | HTTP / WebSocket 共用的登录凭据，至少 32 个字符 |
| `GROK_REMOTE_PORT` | Node 回环端口；未设置时程序默认 3000，正式部署建议显式设置 |
| `GROK_REMOTE_ALLOWED_ORIGINS` | 额外允许的 Origin，逗号分隔 |
| `GROK_REMOTE_PROJECTS_CONFIG` | 项目白名单文件路径 |
| `GROK_BIN` | `grok` 可执行文件；默认从 `PATH` 查找 |
| `GROK_HOME` | 可选。Grok 的数据和会话目录；默认 `~/.grok` |
| `GROK_REMOTE_STATE_DIR` | 可选。本应用事件日志、权限模式、归档和回收站标记；默认 `~/.grok-remote` |
| `GROK_REMOTE_MAX_WORKERS` | 可选。同时活动的 Worker 上限，默认 2；到限拒绝新 Worker |
| `GROK_REMOTE_MIN_FREE_MEMORY_MB` | 可选。启动 Worker 前最低可信可用内存，默认 512；Linux 读取 `MemAvailable`，macOS 读取 `vm_stat` |
| `AI_REMOTE_UPLOAD_SOCKET` | 可选。共享上传服务 Unix socket；默认 `~/.local/share/ai-remote/upload.sock` |

真实令牌和本机项目路径不要进 git。

## 本机试运行

```bash
npm ci --include=dev
cp config/projects.example.json config/projects.json
# 编辑 config/projects.json，把示例项目根目录换成实际位置
GROK_REMOTE_TOKEN="$(openssl rand -hex 32)" \
  GROK_REMOTE_PORT=3000 \
  GROK_REMOTE_PROJECTS_CONFIG="$PWD/config/projects.json" \
  npm start
```

本地健康检查：`http://127.0.0.1:3000/healthz`。生产环境的 HTTPS 入口端口与
Node 回环端口是两项独立配置，不要求使用相同数字。

## 登录与文件查看

通过 HTTPS 入口登录。前端将令牌提交到 `POST /auth/login`，后端签发
`grok-remote-session` cookie（`HttpOnly`、`Secure`、`SameSite=Strict`、`Path=/`）。
HTTP 文件请求、附件上传和 WebSocket 握手统一检查该 cookie；WebSocket 不再接受首帧 `auth`。
升级后各浏览器需要重新登录一次，旧版 localStorage 中的令牌会被删除。

签名凭据没有服务端到期时间，也不依赖内存会话表。保持 `GROK_REMOTE_TOKEN` 不变，
重启后登录状态仍有效；更换该值并重启会让已签发的 cookie 全部失效。
浏览器 cookie 使用 400 天的持久保存期限，并在已登录的 HTTP 请求中续存；
长期未访问、浏览器清理或删除 cookie 后需要重新登录。

文件链接使用当前应用的 HTTPS origin：

```text
https://grok.example.com/view?path=%2Fsrv%2Fprojects%2Fdemo%2FREADME.md
https://grok.example.com/view?path=demo%2Fdiagram.svg
```

`path` 是 URL 编码后的主机绝对路径，或相对于 `projects.json` 中 `roots` 的路径。
有多个根时，相对路径按配置顺序查找；为避免同名文件歧义，建议使用绝对路径。
只允许访问这些根目录内的 `.md`、`.svg`、`.png`、`.jpg`、`.jpeg`、`.gif`、
`.webp`、`.avif`、`.bmp`、`.ico` 文件（后缀不区分大小写）。路径越界、软链接逃逸、
目录和其它后缀均返回 404，没有下载兜底或目录浏览。

`/view` 在浏览器中复用 Markdown 渲染器，图片使用 `<img>`；未登录时提供登录入口并保留
目标链接。`/raw?path=...` 返回文件内容，带 `nosniff`、CSP sandbox 和 `no-store`。
Service Worker 仅缓存公开的应用静态文件，不缓存鉴权响应或文件内容。

## 会话整理

归档和回收站都是本应用自己的标记，不改 Grok CLI 的会话文件。侧栏有最近会话、已归档、回收站三个视图，交互与 Codex Remote 一致。回收站里的会话 30 天后自动永久删除。没发过第一条消息的空会话刷新后不会留在列表里。

## 附件

附件复用 Codex Remote 提供的共享上传服务：浏览器先通过已认证 WebSocket 申请一次性票据，再把原始字节流式发送到同源 `/attachments/upload`。Grok Remote 不复制附件存储，只保存公开元数据和附件 ID，并在任务排队、运行和等待审批期间维护租约。

一条消息最多引用 100 个附件，单文件最多 25 MiB，且发送给 Grok 的附件原始字节合计最多 25 MiB。PNG、JPEG、GIF 和 WebP 映射为 ACP 图片块；UTF-8 文本映射为 ACP 内嵌文本资源；PDF 和其它二进制文件映射为 ACP blob 资源。最终能否理解某种二进制格式仍取决于当前 Grok 版本和可用工具。

## 明确不做

- 每个会话常驻一个 Grok 进程
- 全站共用一个长驻 `grok agent`
- 浏览器直连 `grok agent serve`
- 每条消息用 `grok -p` 起一次性进程
