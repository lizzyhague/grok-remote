# 架构说明

Grok Remote 是单用户自托管的 PWA，用来在手机或电脑上控制主机上的 Grok CLI。
后端只监听 `127.0.0.1`，HTTPS 入口是独立的一层。

```text
浏览器 PWA → HTTPS 入口 → 127.0.0.1:<GROK_REMOTE_PORT>
                              ├→ Unix socket 上的共享 ai-remote-upload（仅附件）
                              └→ 按需 Worker：grok agent stdio（ACP JSON-RPC）
```

浏览器只看到为这个应用设计的小协议，拿不到绝对路径、ACP 内部 id 或终端能力。

## 模块

| 目录 | 负责什么 |
| --- | --- |
| `src/server` | HTTP 与 WebSocket 入口、令牌鉴权、Origin 校验、静态资源、项目锁、在线状态、文件查看 |
| `src/sessions` | 会话登记、历史、归档与回收站标记、磁盘布局 |
| `src/turns` | 一轮对话的执行、事件流、工具展示 |
| `src/worker` | 启停 `grok agent` 子进程、ACP 客户端、JSON-RPC |
| `src/commands` | 斜杠命令目录与执行 |
| `src/projects` | 项目白名单解析 |
| `src/attachments` | 把上传的附件映射成 ACP 输入 |
| `src/shared-upload` | 共享上传服务的客户端 |
| `src/platform` | 平台差异（可用内存读取等） |
| `public/` | 前端 PWA：登录、会话列表、编辑发送、流式显示、Markdown、斜杠菜单 |

## 会话与 Worker

只有在需要执行时才起进程。用户发消息且后端已接受，该会话没有 Worker 就启动一个；
本轮结束且队列为空，Worker 退出。只翻列表或看历史不启动进程。同一会话同时最多一个
Worker。

消息被接受后即可关闭页面，本轮由后端继续跑完并保存。重新打开可以接上正在流式的
输出，或直接读完成的回复。

会话正文以 Grok 自己的磁盘会话为准；本应用额外保存进行中的一轮、事件日志、权限
模式、原生 session id 和归档/回收站标记。

## 权限

审批按「是否还有前端在线」判断，任意在线客户端都能处理。最后一个前端断开后有 10 秒
宽限期；宽限期结束仍无人，待处理审批被拒绝，整轮取消并标为中断。

`always-approve` 模式下无人在线也能继续处理可授权的工具，但需要人回答的问题（如
`ask_user_question`）仍会中止本轮。

## 安全边界

- 只监听回环，入口挂掉也不会绑到公网网卡。
- WebSocket 校验 Origin，令牌定时安全比较。
- 项目必须落在白名单根目录的第一层文件夹内，恢复会话时核对 cwd。
- 不向 Grok 声明可读写任意文件的 `fs` / `terminal` 能力。
- 带绝对路径的错误只写服务日志，浏览器只收到不含路径的说明。
