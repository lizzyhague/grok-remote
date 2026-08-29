# 部署说明

本文只记录可公开、与具体主机无关的部署边界。真实令牌、本机账号、域名和项目绝对路径不应提交到本仓库。

## 文件边界

| 文件 | 是否提交 | 内容 |
| --- | --- | --- |
| `config/projects.example.json` | 是 | 使用示例路径的项目白名单模板 |
| `config/projects.json` | 否 | 实际项目根目录 |
| `deploy/grok-remote.env.example` | 是 | 使用占位值的环境变量模板 |
| `deploy/grok-remote.env` | 否 | 实际令牌、路径和 Origin |
| `deploy/grok-remote.service` | 是 | 使用通用账号和安装位置的 systemd 模板 |

`.gitignore` 已排除两类本地配置。部署时可以从示例复制，再在未跟踪的文件里填写具体值。

## 路径约定

仓库中的部署模板使用以下通用示例：

- 应用安装在 `/opt/grok-remote`
- 服务账号为 `grok-remote`
- 服务账号的 HOME 为 `/var/lib/grok-remote`
- 项目白名单安装为 `/etc/grok-remote/projects.json`
- 环境文件安装为 `/etc/grok-remote.env`

这些不是程序的硬编码要求。使用其它位置时，应在本机环境文件和 systemd unit 中同时调整，公共文档仍保留通用示例。

## 本地配置

开发环境可以从模板建立被 Git 忽略的配置：

```bash
cp config/projects.example.json config/projects.json
cp deploy/grok-remote.env.example deploy/grok-remote.env
```

编辑这两个本地文件后，用 `GROK_REMOTE_PROJECTS_CONFIG` 指向实际的 `projects.json`。生产部署则把同样的值安装到 `/etc` 或部署者选定的私有配置位置。

如果多套 Remote 需要共用项目白名单，它们可以指向同一份未纳入 Git 的 `projects.json`；公共仓库无需知道该文件在某台主机上的实际位置。

## 共享附件服务

附件功能使用 Codex Remote 仓库提供的独立 `ai-remote-upload` 服务。Grok Remote 与该服务必须使用同一个 Unix 账号，才能访问权限为 `0600` 的 socket 和附件文件；不要为了跨账号使用而放宽权限。

`AI_REMOTE_UPLOAD_SOCKET` 必须与共享服务配置一致，默认是 `~/.local/share/ai-remote/upload.sock`。共享服务不可用时，纯文本 Grok Remote 仍可启动和使用，附件票据或上传会明确失败。共享服务的安装、清理、备份和恢复步骤以 Codex Remote 的 `docs/shared-upload-integration.md` 与 `docs/operations.md` 为准。
