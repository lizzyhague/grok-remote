# Deployment

English | [中文](deployment.zh-CN.md)

The backend listens on `127.0.0.1` only. HTTPS is a separate entry layer, and the two ports need not match. Get the local backend working before configuring the entry point.

Do not commit real tokens or host paths. `config/projects.json`, `deploy/grok-remote.env`, and `deploy/*.local` are ignored by Git.

## 1. Prepare the runtime account

Run the service as the Unix user that already has Grok installed and signed in. Grok reads that user's `~/.grok`, the application writes `~/.grok-remote`, and attachments use a socket owned by the same user.

Verify the login environment (Node.js 24 or later is required):

```bash
id -un; id -gn; printf '%s\n' "$HOME"
node --version
command -v node; command -v grok
grok --version
```

## 2. Install code and configuration

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

Replace the example root in `config/projects.json`:

```json
{ "roots": [ { "id": "projects", "path": "/absolute/path/to/projects" } ] }
```

Direct child directories become selectable projects. Set at least these values in `deploy/grok-remote.env`:

| Variable | Value |
| --- | --- |
| `GROK_REMOTE_TOKEN` | Random value generated above, at least 32 characters |
| `GROK_REMOTE_PORT` | Unused loopback port; defaults to 3000 |
| `GROK_REMOTE_PROJECTS_CONFIG` | Absolute path to `config/projects.json` |
| `GROK_BIN` | Absolute path returned by `command -v grok` |

Usually leave `GROK_REMOTE_ALLOWED_ORIGINS` empty. Set complete origins only when the reverse proxy does not preserve `Host` or `X-Forwarded-Host`.

## 3a. Linux with systemd

```bash
cp deploy/grok-remote.service.example deploy/grok-remote.service.local
```

Replace `__RUN_USER__`, `__RUN_GROUP__`, `__RUN_HOME__`, `__APP_DIR__`, `__ENV_FILE__`, `__NODE_BIN__`, and `__RUNTIME_PATH__`, then verify and install:

```bash
grep -n '__[A-Z_]*__' deploy/grok-remote.service.local   # no output expected
sudo install -m 0644 deploy/grok-remote.service.local /etc/systemd/system/grok-remote.service
sudo systemctl daemon-reload
sudo systemctl enable --now grok-remote.service
curl --fail --show-error http://127.0.0.1:3000/healthz
```

## 3b. macOS with launchd

Use a system LaunchDaemon so the service does not depend on a graphical login. `UserName` remains the ordinary Grok user.

```bash
cp deploy/com.example.grok-remote.plist.example deploy/com.example.grok-remote.plist.local
mkdir -p "$HOME/Library/Logs/grok-remote" && chmod 700 "$HOME/Library/Logs/grok-remote"
```

Also replace `__SERVICE_LABEL__` and `__LOG_DIR__`. The filename, plist `Label`, and `launchctl` command must agree.

```bash
plutil -lint deploy/com.example.grok-remote.plist.local
grep -n '__[A-Z_]*__' deploy/com.example.grok-remote.plist.local   # no output expected
sudo install -o root -g wheel -m 0644 \
  deploy/com.example.grok-remote.plist.local \
  /Library/LaunchDaemons/com.example.grok-remote.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.example.grok-remote.plist
sudo launchctl kickstart -k system/com.example.grok-remote
curl --fail --show-error http://127.0.0.1:3000/healthz
```

Put proxy variables such as `HTTPS_PROXY` in `deploy/grok-remote.env`; use `NO_PROXY` for `127.0.0.1`, `localhost`, and private entry points. Do not configure HTTPS until the health check passes.

## 4. HTTPS entry point

Example Tailscale Serve entry, visible only to the tailnet:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3000
tailscale serve status
```

Open it from another tailnet device, sign in, and send a test message. Other reverse proxies work as well if they forward WebSocket and upload requests correctly.

## 5. Attachments (optional)

Install [`ai-remote-upload`](https://github.com/lizzyhague/ai-remote-upload) from its own repository and run it as the same Unix user with socket mode 0600. Do not copy service code from Codex Remote or this repository.

`AI_REMOTE_UPLOAD_SOCKET` must match the shared service and defaults to `~/.local/share/ai-remote/upload.sock`. Plain text keeps working when that service is absent; attachments fail explicitly. Updating or stopping Grok Remote must not update, stop, or restart the upload service.

## 6. Frontend releases

There is no frontend build command. Before listening, the service reads the complete frontend and writes content-addressed assets under ignored `public/.web-assets/`. The runtime user needs write access. Working-tree changes do not affect a running process; frontend and backend switch together on restart. Startup fails if a referenced frontend file is missing.

The directory retains the current assets and those from the previous two starts. Do not clear or commit it. New scripts or styles must be added to the static-file allowlist in `src/server/http-server.ts`; existing files need no manual version change. See [Operations](operations.md#updates) for update and rollback steps.

Online refreshes load the current page and matching assets. Pull to refresh works from the chat list, session list, or blank title-bar space. Service Worker updates do not force a reload. Offline mode uses the latest complete cached shell, but sessions still require a network connection.
