# Operations

English | [中文](operations.zh-CN.md)

## Updates

Frontend and backend switch as one version. The service snapshots the complete frontend before listening, so working-tree changes do not affect the running process until restart. Pull and validate as the code owner:

```bash
previous=$(git rev-parse HEAD)
git pull --ff-only
npm ci --include=dev
npm run typecheck && npm test
```

If validation fails, do not restart:

```bash
git reset --hard "$previous"
npm ci --include=dev
```

After successful validation, restart on Linux:

```bash
sudo systemctl restart grok-remote.service
curl --fail --show-error http://127.0.0.1:3000/healthz
```

Or on macOS:

```bash
sudo launchctl kickstart -k system/<your-label>
curl --fail --show-error http://127.0.0.1:3000/healthz
```

Node runs TypeScript source directly; there is no build step. Restarting this service does not involve the entry point, other Remote services, or the separate `ai-remote-upload` service. Do not restart the upload service when updating this one.

## Status and logs

Linux:

```bash
systemctl status grok-remote.service --no-pager
journalctl -u grok-remote.service -n 50 --no-pager
```

On macOS, inspect `grok-remote.log` and `grok-remote.error.log` in the runtime user's configured log directory.

## Adding frontend files

`public/` is allowlisted rather than served as a directory. When adding or renaming a frontend file, register its URL, filename, and Content-Type in `STATIC_FILES` in `src/server/http-server.ts`, and verify a 200 response in `http-server.test.ts`. Scripts and styles receive content-addressed `/assets/<hash>/` URLs under `public/.web-assets/`; changing an existing file requires no manual HTML or Service Worker version update. Any frontend or backend change needs a restart to take effect.

The service retains assets for the current release and the previous two starts. Do not clear `public/.web-assets/` manually. The browser's offline cache retains the current and previous complete shells.

## Maintaining interface text

Keep every stable key and its Chinese and English values together in `public/strings.js`. Tests verify that both languages use matching parameters and that keys referenced by frontend and backend code exist. Backend-originated page text should use a key and parameters; internal logs remain English.

## Troubleshooting

If the page does not open, check outward from the service: loopback `/healthz`, active process, HTTPS proxy target, then firewall, DNS, and tailnet ACLs.

If sign-in fails, verify the token in the environment file. For rejected WebSockets, inspect logged Origin and Host values. If page scripts do not start, confirm that `boot.js`, `app.js`, and their dependencies return 200.

With a complete online deployment, an ordinary refresh loads the current page and matching assets. Pull to refresh is available from the chat list, session list, or blank title-bar space. Service Worker updates never reload the page automatically. Offline mode opens only the latest complete shell; session features still require the network.
