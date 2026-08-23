# Grok Remote

单用户、自托管 PWA。在手机或电脑上控制这台 Linux 主机上的 Grok Build CLI。

消息在浏览器里编完再发。后端接受后可以关掉页面，本轮由按需 Worker（`grok agent stdio`）继续跑。

> 不是官方产品，也不是多人账户。部署者是唯一受信任的使用者。

对照范围见 [`docs/design.md`](docs/design.md)。本应用与 Codex Remote 独立部署并使用不同入口，UI 布局、视觉和通用交互保持同步；Grok 能力差异单独适配。通用部署边界见 [`docs/deployment.md`](docs/deployment.md)。

## 数据路径

```text
浏览器 PWA
  → HTTPS（Tailscale Serve 或公网反代）
  → 127.0.0.1:8788 上的 Grok Remote
  → 仅在需要执行时：grok agent stdio（ACP JSON-RPC）
  → Grok 原生会话 ~/.grok/sessions/<按工作目录分组>/<session-id>/
```

服务只绑 `127.0.0.1`。浏览器只看见为本 PWA 准备的小协议，不会直接碰到 ACP、文件系统或终端。

## 要求

- Linux 主机
- Node.js 24 或更新版本
- 已安装并登录 `grok`
- 一份项目白名单 `projects.json`（可与其它 Remote 共用，用 `GROK_REMOTE_PROJECTS_CONFIG` 指向）

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `GROK_REMOTE_TOKEN` | WebSocket 登录令牌，至少 32 个字符 |
| `GROK_REMOTE_PORT` | 回环端口，默认 8788 |
| `GROK_REMOTE_ALLOWED_ORIGINS` | 额外允许的 Origin，逗号分隔 |
| `GROK_REMOTE_PROJECTS_CONFIG` | 项目白名单文件路径 |
| `GROK_BIN` | `grok` 可执行文件；默认从 `PATH` 查找 |
| `GROK_REMOTE_STATE_DIR` | 可选。本应用事件日志和权限模式；默认 `~/.grok-remote` |
| `GROK_REMOTE_MAX_WORKERS` | 可选。同时活动的 Worker 上限，默认 2；到限拒绝新 Worker |
| `GROK_REMOTE_MIN_FREE_MEMORY_MB` | 可选。启动 Worker 前最低可用内存，默认 512 |

真实令牌和本机项目路径不要进 git。

## 本机试运行

```bash
npm ci
cp config/projects.example.json config/projects.json
# 编辑 config/projects.json，把示例项目根目录换成实际位置
GROK_REMOTE_TOKEN="$(openssl rand -hex 32)" \
  GROK_REMOTE_PROJECTS_CONFIG="$PWD/config/projects.json" \
  npm start
```

健康检查：`http://127.0.0.1:8788/healthz`

## 第一版明确不做

- 文件上传
- 会话归档 / 回收站（删除就是永久删除）
- 每个会话常驻一个 Grok 进程
- 全站共用一个长驻 `grok agent`
- 浏览器直连 `grok agent serve`
- 每条消息用 `grok -p` 起一次性进程
