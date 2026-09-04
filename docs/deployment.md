# 部署说明

本文先给出 Linux 和 macOS 共用的准备步骤，再给出 Linux + systemd 部署方式。macOS +
launchd 的后续步骤见 [`deployment-macos.md`](deployment-macos.md)。仓库不假定主机名、Unix 用户、
安装目录、Node/Grok 路径、回环端口或 HTTPS 入口端口。真实令牌和主机路径不应提交。

Grok Remote 始终只监听 `127.0.0.1`。Tailscale Serve、Caddy、nginx 等 HTTPS 入口是
独立的一层：

```text
浏览器 → HTTPS:<入口端口> → 127.0.0.1:<GROK_REMOTE_PORT>
```

这两个端口不要求相同。先验证本地后端，再配置远程入口。

## 文件边界

| 文件 | 是否提交 | 内容 |
| --- | --- | --- |
| `config/projects.example.json` | 是 | 使用示例路径的项目白名单模板 |
| `config/projects.json` | 否 | 本机实际项目根目录 |
| `deploy/grok-remote.env.example` | 是 | 环境变量模板 |
| `deploy/grok-remote.env` | 否 | 本机令牌、路径和回环端口 |
| `deploy/grok-remote.service.example` | 是 | 带占位符的 systemd 模板 |
| `deploy/grok-remote.service.local` | 否 | 填入本机用户和绝对路径的 unit |

两份本地配置文件已由 `.gitignore` 排除。生产 unit 最终安装到
`/etc/systemd/system/grok-remote.service`，但仓库不规定源代码必须位于 `/opt` 或其它目录。

## 1. 选择运行用户

服务默认应由已经安装并登录 Grok 的 Unix 用户运行，而不是随意新建一个专用账号。
这是运行边界，不只是部署偏好：

- Grok 默认从该用户的 `~/.grok` 读取登录状态和会话；
- Grok Remote 默认把自己的状态写入该用户的 `~/.grok-remote`；
- 使用附件时，Grok Remote 必须能访问同一用户下的 `ai-remote-upload` socket。

只有在准备好为专用账号单独安装并登录 Grok、设置 HOME 并处理附件权限后，才使用
专用服务账号。不要通过放宽 Grok 数据目录或上传 socket 权限来跨账号共享。

以下命令均应先在计划运行服务的用户登录环境中核验：

```bash
id -un
id -gn
printf '%s\n' "$HOME"
command -v node
node --version
command -v npm
npm --version
command -v grok
grok --version
```

要求 Node.js 24 或更新版本。还应确认该用户可以直接使用 Grok CLI，而不只是存在一个
`grok` 文件。安装 Node 或登录 Grok 的方法因主机而异，不由本仓库自动修改。

## 2. 安装代码和依赖

克隆仓库或进入已有工作树，然后安装锁定依赖并验证：

```bash
git clone https://github.com/lizzyhague/grok-remote.git
cd grok-remote
npm ci --include=dev
npm run typecheck
npm test
```

后续所有相对路径都以这个仓库根目录为准。systemd 模板要求填绝对路径；建议避免在
安装路径中使用空格。

## 3. 配置项目白名单

```bash
cp config/projects.example.json config/projects.json
chmod 600 config/projects.json
```

编辑 `config/projects.json`，将示例根目录替换为本机实际目录：

```json
{
  "roots": [
    {
      "id": "projects",
      "path": "/absolute/path/to/projects"
    }
  ]
}
```

网页中可选的项目是每个根目录下的第一层文件夹。多套 Remote 可以指向同一份未跟踪的
`projects.json`，也可以各自使用一份；公共仓库不应知道它在某台主机上的真实路径。

## 4. 配置环境变量

```bash
cp deploy/grok-remote.env.example deploy/grok-remote.env
chmod 600 deploy/grok-remote.env
openssl rand -hex 32
```

把最后一条命令的结果填入 `GROK_REMOTE_TOKEN`，并填写以下必需值：

- `GROK_REMOTE_PORT`：未被占用的本地回环端口；正式部署应显式设置；
- `GROK_REMOTE_PROJECTS_CONFIG`：上一步配置文件的绝对路径；
- `GROK_BIN`：`command -v grok` 返回的绝对路径。

正常保留 `Host` 或 `X-Forwarded-Host` 的同源反向代理不需要设置
`GROK_REMOTE_ALLOWED_ORIGINS`。只有入口 Origin 无法由这些请求头识别时，才把完整的
`https://...` Origin 加入该变量。

程序未设置 `GROK_REMOTE_PORT` 时默认使用 `3000`，这只是本地开发默认值，不是要求所有
主机采用同一个生产端口。

## 5. 建立 systemd 服务

```bash
cp deploy/grok-remote.service.example deploy/grok-remote.service.local
```

编辑本地副本并替换所有占位符：

| 占位符 | 填写内容 |
| --- | --- |
| `__RUN_USER__` | `id -un` 的结果 |
| `__RUN_GROUP__` | `id -gn` 的结果 |
| `__RUN_HOME__` | 运行用户的 HOME 绝对路径 |
| `__APP_DIR__` | 仓库根目录绝对路径 |
| `__ENV_FILE__` | `deploy/grok-remote.env` 的绝对路径 |
| `__NODE_BIN__` | `command -v node` 的绝对路径 |
| `__RUNTIME_PATH__` | 包含 Node、Grok 和常用系统命令目录的完整 `PATH` |

确认没有遗留占位符：

```bash
if grep -n '__[A-Z_]*__' deploy/grok-remote.service.local; then
  echo 'systemd 模板仍有未替换的占位符' >&2
  exit 1
fi
```

安装并启动服务需要系统管理员权限：

```bash
sudo install -m 0644 deploy/grok-remote.service.local /etc/systemd/system/grok-remote.service
sudo systemctl daemon-reload
sudo systemctl enable --now grok-remote.service
```

先只验证本地后端，其中端口应与环境文件一致：

```bash
curl --fail --show-error http://127.0.0.1:3000/healthz
sudo systemctl status grok-remote.service --no-pager
```

如果使用了其它回环端口，把示例中的 `3000` 换成实际值。启动失败时查看：

```bash
sudo journalctl -u grok-remote.service -n 50 --no-pager
```

不要在健康检查失败时继续配置反向代理。

## 6. 配置 Tailscale Serve（可选）

这一节只适用于已经加入 tailnet、并希望仅向 tailnet 暴露服务的主机。不要把 Serve
改成 Funnel；也不要照搬其它主机的端口。先为当前主机选择一个未占用的 HTTPS 入口端口。

下面的 `8443` 和 `3000` 只是示例：

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3000
tailscale serve status
```

状态中应清楚显示：

```text
https://<本机的-tailnet-DNS-名>:8443
└── proxy http://127.0.0.1:3000
```

随后从另一台有权限的 tailnet 设备打开该 HTTPS URL，完成登录并发送一次测试消息。
Tailscale Serve 的访问仍受 tailnet ACL 约束。使用其它反向代理时也应保持 Node 只监听
回环地址，并正确转发 WebSocket 和上传请求。

## 7. 共享附件服务（可选）

附件功能使用独立的 `ai-remote-upload` 服务。Grok Remote 与它必须使用同一个 Unix 用户，
才能访问权限为 `0600` 的 socket 和附件文件。

`AI_REMOTE_UPLOAD_SOCKET` 必须与共享服务配置一致，默认是
`~/.local/share/ai-remote/upload.sock`。共享服务不存在时，纯文本 Grok Remote 仍可启动
和使用；附件票据或上传会明确失败。部署新主机时可以先验收纯文本，再单独接入附件服务。

## 8. 更新

在仓库目录中以代码所有者身份更新并验证：

```bash
git pull --ff-only
npm ci --include=dev
npm run typecheck
npm test
```

测试通过后再重启：

```bash
sudo systemctl restart grok-remote.service
curl --fail --show-error http://127.0.0.1:3000/healthz
```

如果本机使用其它回环端口，相应替换健康检查地址。重启只影响 Grok Remote 后端；修改
Tailscale Serve、主机网络或其它 Remote 不属于普通应用更新步骤。
