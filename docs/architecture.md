# Architecture

English | [中文](architecture.zh-CN.md)

Grok Remote is a single-user, self-hosted PWA for controlling the Grok CLI from a phone or computer. The backend listens on `127.0.0.1` only; HTTPS is a separate entry layer.

```text
Browser PWA -> HTTPS entry point -> 127.0.0.1:<GROK_REMOTE_PORT>
                                      |-> shared ai-remote-upload on a Unix socket (attachments only)
                                      `-> on-demand worker: grok agent stdio (ACP JSON-RPC)
```

The browser sees only the restricted application protocol. It receives no absolute paths, ACP internal IDs, or terminal capability.

## Modules

| Directory | Responsibility |
| --- | --- |
| `src/server` | HTTP and WebSocket entry points, authentication, origin checks, static assets, project locks, presence, and file viewing |
| `src/sessions` | Session registry and history, archive and trash marks, disk layout |
| `src/turns` | Turn execution, event stream, and tool presentation |
| `src/worker` | `grok agent` process lifecycle, ACP client, and JSON-RPC |
| `src/commands` | Slash-command catalog and execution |
| `src/projects` | Project allowlist parsing |
| `src/attachments` | Attachment path instructions for the CLI and replacement of known paths with original names |
| `src/shared-upload` | Thin client for the separate `ai-remote-upload` project |
| `src/shared` | Stable interface-text keys and parameters sent by the backend |
| `src/platform` | Platform differences such as available-memory readings |
| `public/` | PWA frontend: sign-in, sessions, composer, streaming, Markdown, commands, and localization |

## Interface language

Interface text lives in `public/strings.js`. Backend notices, errors, and command results carry stable keys and parameters; the browser renders them in its current language, while server logs remain English. Existing conversation content is not redrawn when the language changes.

The platform instructions sent to Grok are always English. Attachment display lines use the fixed form `[Attachment: original-name · ID]` so optimistic and persisted messages match.

## Sessions and workers

A process starts only when work needs to run. If an accepted message has no worker, the backend starts one; the worker exits when the turn and queue finish. Browsing sessions or history starts no process. A session has at most one worker at a time.

After the backend accepts a message, the page may close while the turn completes and is saved. Reopening resumes the live stream or loads the completed reply.

Grok's native session is the source of truth for conversation content. The application additionally stores active-turn state, events, permission mode, native session ID, archive and trash marks, and an attachment display index containing IDs, original names, and real paths.

## Permissions

Any online client may handle an approval. After the last frontend disconnects there is a 10-second grace period; when it expires, a pending approval is rejected and the turn is cancelled and marked interrupted.

With `always-approve`, approvable tools may continue while nobody is online. Questions that require a human answer, such as `ask_user_question`, still interrupt the turn.

## Security boundaries

- The backend listens on loopback only.
- WebSocket upgrades validate Origin, and token comparison is timing safe.
- Projects must be direct children of configured roots; resumed sessions revalidate their working directory.
- Grok is not advertised arbitrary `fs` or `terminal` capabilities.
- Errors containing absolute paths stay in service logs; the browser receives a path-free message.
- Real attachment paths appear only in CLI input and the private attachment index. Browser events, tools, approvals, replies, and history remove private path blocks and replace known paths with original names.
