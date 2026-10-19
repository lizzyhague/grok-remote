# Grok Remote

English | [中文](README.zh-CN.md)

Grok Remote is a single-user, self-hosted PWA for controlling the Grok Build CLI on a Linux or macOS host from a phone or computer.

Messages are composed in the browser and sent in full. Once the backend accepts a message, the page may be closed while an on-demand worker (`grok agent stdio`) completes the turn.

> This is not an official product or a multi-user account system. It assumes the person deploying it is the only trusted user.

Grok Remote is deployed separately from Codex Remote and uses a different entry point. The projects keep their UI layout, visual design, and common interactions aligned while adapting product-specific capabilities independently. See [`docs/deployment.md`](docs/deployment.md) for the shared deployment boundaries.

## Features

- Browse projects from configured roots and manage sessions created by Grok Remote.
- Stream replies, tool activity, approvals, and slash-command results.
- Send ordinary files through the separate shared upload service.
- Use the interface in Chinese or English. It follows the browser language by default, and the choice is stored only in that browser.
- Install the application as a PWA.

## Data path

```text
Browser PWA
  -> HTTPS entry point (Tailscale Serve or another reverse proxy)
  -> Grok Remote Node backend on 127.0.0.1:<GROK_REMOTE_PORT>
  -> shared ai-remote-upload on a Unix socket (attachments only)
  -> only while work is running: grok agent stdio (ACP JSON-RPC)
  -> native Grok sessions in ~/.grok/sessions/<grouped-by-working-directory>/<session-id>/
```

The service listens on `127.0.0.1` only. The browser sees a small protocol designed for this PWA and never connects directly to ACP, the filesystem, or a terminal.

## Requirements

- A Linux or macOS host
- Node.js 24 or later
- `grok` installed and signed in
- A `projects.json` allowlist (it may be shared with another Remote through `GROK_REMOTE_PROJECTS_CONFIG`)
- For attachments, the separate [`ai-remote-upload`](https://github.com/lizzyhague/ai-remote-upload) service running as the same Unix user

See [`docs/deployment.md`](docs/deployment.md) for general preparation, Linux with systemd, and macOS with launchd.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GROK_REMOTE_TOKEN` | Shared HTTP / WebSocket sign-in credential; at least 32 characters |
| `GROK_REMOTE_PORT` | Node loopback port; defaults to 3000, but should be explicit in a real deployment |
| `GROK_REMOTE_ALLOWED_ORIGINS` | Extra allowed origins, comma separated |
| `GROK_REMOTE_PROJECTS_CONFIG` | Project allowlist path |
| `GROK_BIN` | `grok` executable; found on `PATH` by default |
| `GROK_HOME` | Optional Grok data and session directory; defaults to `~/.grok` |
| `GROK_REMOTE_STATE_DIR` | Optional event log, permission mode, archive, and trash state; defaults to `~/.grok-remote` |
| `GROK_REMOTE_MAX_WORKERS` | Optional active-worker limit; defaults to 4; new workers are refused at the limit |
| `GROK_REMOTE_MIN_FREE_MEMORY_MB` | Optional minimum reliable available memory before starting a worker; defaults to 512; Linux uses `MemAvailable`, macOS uses `vm_stat` |
| `AI_REMOTE_UPLOAD_SOCKET` | Optional shared upload Unix socket; defaults to `~/.local/share/ai-remote/upload.sock` |

Never commit real tokens or host-specific project paths.

## Local trial run

```bash
npm ci --include=dev
cp config/projects.example.json config/projects.json
# Replace the example project root with a real path.
GROK_REMOTE_TOKEN="$(openssl rand -hex 32)" \
  GROK_REMOTE_PORT=3000 \
  GROK_REMOTE_PROJECTS_CONFIG="$PWD/config/projects.json" \
  npm start
```

The local health check is `http://127.0.0.1:3000/healthz`. The production HTTPS entry port and the Node loopback port are separate settings and need not match.

## Sign-in and file viewing

Sign in through the HTTPS entry point. The frontend submits the token to `POST /auth/login`, and the backend issues a `grok-remote-session` cookie with `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/`. HTTP file requests, attachment uploads, and WebSocket upgrades all validate this cookie; WebSocket no longer accepts a first-frame `auth` message. After this upgrade, each browser must sign in again; tokens previously stored in localStorage are removed.

The signed credential has no server-side expiry and does not depend on an in-memory session table. It remains valid across restarts while `GROK_REMOTE_TOKEN` stays unchanged. Rotating that value and restarting invalidates every issued cookie. The browser stores the cookie for 400 days and renews it during authenticated HTTP requests. A long idle period, browser cleanup, or deleting the cookie requires signing in again.

File links use the application's HTTPS origin:

```text
https://grok.example.com/view?path=%2Fsrv%2Fprojects%2Fdemo%2FREADME.md
```

`path` must be a URL-encoded absolute host path; relative paths return 404. Viewing is limited to `.md`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, `.bmp`, and `.ico` files inside configured viewable roots (extensions are case-insensitive). Escaping through paths or symlinks, directories, and other extensions return 404; there is no download or directory-browsing fallback.

`/view` reuses the Markdown renderer and displays images with `<img>`. Unauthenticated visits get a sign-in link that keeps the target. `/raw?path=...` returns content with `nosniff`, a sandbox CSP, and `no-store`. The Service Worker caches only public application assets, never authenticated responses or file contents.

Appearance and interface language are stored only in the browser and are not sent to the server.

## Session organization

The sidebar lists only sessions created by Grok Remote. Archive and trash are application-owned marks and do not modify Grok CLI session files. The sidebar has recent, archived, and trash views, with the same interaction as Codex Remote. Trash is permanently deleted after 30 days. Empty sessions that never sent a first message disappear after refresh.

## Attachments

Attachments use the separate [`ai-remote-upload`](https://github.com/lizzyhague/ai-remote-upload) project. The browser requests a one-time ticket through the authenticated WebSocket and streams bytes to same-origin `/attachments/upload`. Grok Remote does not copy attachment storage; it stores only public metadata and attachment IDs, maintains leases while work is queued, running, or waiting for approval, and gives the real paths to Grok CLI when the message is sent. Follow that project's deployment docs; do not take the service code from the Codex Remote repository.

A message may reference up to 100 attachments, each up to 25 MiB. The page shows original names and never storage paths. Grok Remote does not decode file contents by MIME type or reject ordinary files. Whether Grok can read a format depends on the installed Grok version and its available tools.

## Explicit non-goals

- One permanently running Grok process per session
- One global long-lived `grok agent`
- Direct browser access to `grok agent serve`
- A new `grok -p` process for every message
