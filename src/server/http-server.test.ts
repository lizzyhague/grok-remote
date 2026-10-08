import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { CommandRunner } from "../commands/runner.ts";
import { GrokSessionDisk } from "../sessions/disk.ts";
import { RemoteSessionStore } from "../sessions/store.ts";
import { TurnRuntime } from "../turns/runtime.ts";
import type { BrowserConnectionServices } from "./connection.ts";
import { RemoteWebSocketServer } from "./http-server.ts";
import { PresenceTracker } from "./presence.ts";
import { ProjectTaskLocks } from "./project-locks.ts";
import type { OpenedSession, SessionPage } from "../sessions/service.ts";

// 服务启动时会发布并回收前端快照；测试用 public/ 的临时副本，不动部署目录里的 .web-assets。
const WEB_ROOT = await mkdtemp(path.join(tmpdir(), "grok-http-public-"));
after(() => rm(WEB_ROOT, { recursive: true, force: true }));
await cp(fileURLToPath(new URL("../../public/", import.meta.url)), WEB_ROOT, {
  recursive: true,
  filter: (source) => path.basename(source) !== ".web-assets",
});

test("serves health and authenticated WebSocket only on loopback", async () => {
  const harness = emptyServices();
  const { services } = harness;
  const server = new RemoteWebSocketServer({
    token: "test-secret-token-value-32chars!!",
    services,
    webRoot: WEB_ROOT,
  });
  const address = await server.listen(0);
  const cookie = await loginCookie(`http://${address.host}:${address.port}`);
  const webSocket = new WebSocket(`ws://${address.host}:${address.port}/ws`, { headers: { cookie } });
  const opened = once(webSocket, "open");

  try {
    const health = await fetch(`http://${address.host}:${address.port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const page = await fetch(`http://${address.host}:${address.port}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Grok Remote/);
    assert.match(html, /\/assets\/[a-f0-9]{64}\/app\.js/u);
    assert.match(html, /<meta name="grok-remote-assets"/u);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(page.headers.get("cache-control") ?? "", /no-cache/u);

    const worker = await fetch(`http://${address.host}:${address.port}/sw.js`);
    assert.equal(worker.status, 200);
    assert.match(worker.headers.get("cache-control") ?? "", /no-cache/u);
    assert.equal(worker.headers.get("service-worker-allowed"), "/");

    for (const asset of ["/boot.js", "/markdown.js", "/notice.js", "/slash-menu.js"]) {
      const response = await fetch(`http://${address.host}:${address.port}${asset}`);
      assert.equal(response.status, 200, `${asset} should be served`);
    }

    for (const asset of ["/icon-192.png", "/icon-512.png", "/icon-512-maskable.png"]) {
      const response = await fetch(`http://${address.host}:${address.port}${asset}`);
      assert.equal(response.status, 200, `${asset} should be served`);
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.deepEqual(
        [...new Uint8Array(await response.arrayBuffer()).slice(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
    }

    const missing = await fetch(`http://${address.host}:${address.port}/not-a-file`);
    assert.equal(missing.status, 404);

    await withTimeout(opened, "打开 WebSocket");
    webSocket.send(JSON.stringify({
      type: "projects.list",
      requestId: "projects-1",
    }));
    const authMessage = await withTimeout(once(webSocket, "message"), "等待认证响应");
    const auth = JSON.parse(String(authMessage[0])) as { ok: boolean };
    assert.equal(auth.ok, true);
    assert.equal(address.host, "127.0.0.1");
  } finally {
    if (webSocket.readyState !== WebSocket.CLOSED) webSocket.close();
    await withTimeout(server.close(), "关闭服务器");
    await harness.turns.dispose();
    services.presence.dispose();
  }
});

test("only accepts WebSocket upgrades from its own page", async () => {
  const harness = emptyServices();
  const { services } = harness;
  const server = new RemoteWebSocketServer({
    token: "test-secret-token-value-32chars!!",
    services,
    webRoot: WEB_ROOT,
    allowedOrigins: ["https://vps.example.ts.net"],
  });
  const address = await server.listen(0);
  const url = `ws://${address.host}:${address.port}/ws`;
  const cookie = await loginCookie(`http://${address.host}:${address.port}`);

  try {
    const attacker = new WebSocket(url, {
      headers: { cookie, origin: "https://attacker.example" },
    });
    const rejected = await withTimeout(
      once(attacker, "error").then(() => "rejected" as const),
      "等待跨站连接被拒绝",
    );
    assert.equal(rejected, "rejected");

    const sameOrigin = new WebSocket(url, {
      headers: { cookie, origin: `http://${address.host}:${address.port}` },
    });
    await withTimeout(once(sameOrigin, "open"), "打开同源 WebSocket");
    sameOrigin.close();

    const proxied = new WebSocket(url, {
      headers: { cookie, origin: "https://vps.example.ts.net" },
    });
    await withTimeout(once(proxied, "open"), "打开白名单来源的 WebSocket");
    proxied.close();

    const headless = new WebSocket(url, { headers: { cookie } });
    await withTimeout(once(headless, "open"), "打开无 Origin 的 WebSocket");
    headless.close();
  } finally {
    await withTimeout(server.close(), "关闭服务器");
    await harness.turns.dispose();
    services.presence.dispose();
  }
});

test("streams same-origin uploads through the shared upload adapter", async () => {
  const harness = emptyServices();
  const received: Buffer[] = [];
  const server = new RemoteWebSocketServer({
    token: "test-secret-token-value-32chars!!",
    services: harness.services,
    webRoot: WEB_ROOT,
    uploads: {
      async upload(ticket, contentLength, source) {
        assert.equal(ticket, "ticket-secret");
        assert.equal(contentLength, 5);
        for await (const chunk of source) received.push(Buffer.from(chunk));
        return {
          id: "attachment-1",
          caller: "grok",
          projectId: "projects/demo",
          sessionId: "session-1",
          originalName: "note.txt",
          declaredMime: "text/plain",
          detectedMime: "text/plain",
          kind: "file",
          size: 5,
          sha256: "test",
          createdAtMs: 1,
          expiresAtMs: 2,
        };
      },
    },
  });
  const address = await server.listen(0);
  const origin = `http://${address.host}:${address.port}`;
  const cookie = await loginCookie(origin);
  try {
    const uploaded = await fetch(`${origin}/attachments/upload`, {
      method: "POST",
      headers: { cookie, origin, "x-upload-ticket": "ticket-secret" },
      body: Buffer.from("hello"),
    });
    assert.equal(uploaded.status, 201);
    const body = await uploaded.json() as { attachment: Record<string, unknown> };
    assert.equal(body.attachment.id, "attachment-1");
    assert.equal("path" in body.attachment, false);
    assert.equal(Buffer.concat(received).toString("utf8"), "hello");

    const crossOrigin = await fetch(`${origin}/attachments/upload`, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "x-upload-ticket": "ticket-secret",
      },
      body: Buffer.from("hello"),
    });
    assert.equal(crossOrigin.status, 403);
  } finally {
    await withTimeout(server.close(), "关闭服务器");
    await harness.turns.dispose();
    harness.services.presence.dispose();
  }
});

test("HTTP login, protected routes and WebSocket use the same persistent cookie", async (t) => {
  const harness = emptyServices();
  const token = "test-secret-token-value-32chars!!";
  let server = new RemoteWebSocketServer({ token, services: harness.services, webRoot: WEB_ROOT });
  t.after(async () => {
    await server.close();
    await harness.turns.dispose();
    harness.services.presence.dispose();
  });
  let address = await server.listen(0);
  let origin = `http://${address.host}:${address.port}`;
  const protectedRaw = `/raw?${new URLSearchParams({ path: path.join(tmpdir(), "note.md") })}`;
  for (const route of ["/auth/session", protectedRaw, "/attachments/upload"]) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const noCookie = new WebSocket(`ws://${address.host}:${address.port}/ws`);
  assert.match(String((await once(noCookie, "error"))[0]), /401/);
  const forged = new WebSocket(`ws://${address.host}:${address.port}/ws`, {
    headers: { cookie: "grok-remote-session=forged" },
  });
  assert.match(String((await once(forged, "error"))[0]), /401/);
  for (const [body, status] of [["{", 400], [JSON.stringify({ token: "wrong" }), 401],
    [JSON.stringify({ token: "x".repeat(17000) }), 413]] as const) {
    const response = await fetch(`${origin}/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  const crossSite = await fetch(`${origin}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ token }),
  });
  assert.equal(crossSite.status, 403);
  const cookie = await loginCookie(origin);
  await server.close();
  server = new RemoteWebSocketServer({ token, services: harness.services, webRoot: WEB_ROOT });
  address = await server.listen(0);
  origin = `http://${address.host}:${address.port}`;
  const session = await fetch(`${origin}/auth/session`, { headers: { cookie } });
  assert.equal(session.status, 200);
  assert.ok(session.headers.get("set-cookie")?.startsWith(cookie));
  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`, { headers: { cookie } });
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "projects.list", requestId: "p" }));
  assert.equal(JSON.parse(String((await once(socket, "message"))[0])).ok, true);
  socket.close();
  await server.close();
  server = new RemoteWebSocketServer({ token: `${token}-changed`, services: harness.services, webRoot: WEB_ROOT });
  address = await server.listen(0);
  const revoked = await fetch(`http://${address.host}:${address.port}/auth/session`, { headers: { cookie } });
  assert.equal(revoked.status, 401);
});

test("raw serves only caged markdown and images with sandbox headers; view assets are available", async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "grok-http-files-")));
  const root = path.join(temp, "root");
  await mkdir(root);
  await writeFile(path.join(root, "文档 # ? %.md"), "# Hello\n<script>alert(1)</script>");
  await writeFile(path.join(root, "image.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await writeFile(path.join(root, "config.json"), "{}");
  await writeFile(path.join(temp, "outside.md"), "outside");
  await symlink(path.join(temp, "outside.md"), path.join(root, "escape.md"));
  const harness = emptyServices();
  const server = new RemoteWebSocketServer({
    token: "test-secret-token-value-32chars!!", services: harness.services, fileRoots: [root], webRoot: WEB_ROOT,
  });
  t.after(async () => {
    await server.close();
    await harness.turns.dispose();
    harness.services.presence.dispose();
    await rm(temp, { recursive: true, force: true });
  });
  const address = await server.listen(0);
  const origin = `http://${address.host}:${address.port}`;
  const cookie = await loginCookie(origin);
  for (const file of ["文档 # ? %.md", "image.svg"]) {
    const url = `${origin}/raw?${new URLSearchParams({ path: path.join(root, file) })}`;
    const response = await fetch(url, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy")!, /^sandbox;/);
    assert.equal(response.headers.get("content-type"), file.endsWith("md")
      ? "text/markdown; charset=utf-8" : "image/svg+xml");
    assert.ok((await response.text()).includes("<script>"));
    const head = await fetch(url, { method: "HEAD", headers: { cookie } });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(head.headers.get("content-length"), response.headers.get("content-length"));
  }
  for (const file of [
    path.join(temp, "outside.md"),
    path.join(root, "escape.md"),
    path.join(root, "config.json"),
    path.join(root, "missing.png"),
  ]) {
    const response = await fetch(`${origin}/raw?${new URLSearchParams({ path: file })}`, { headers: { cookie } });
    assert.equal(response.status, 404, file);
  }
  assert.equal((await fetch(`${origin}/raw?path=note.md`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(`${origin}/raw?path=a.md&path=b.md`, { headers: { cookie } })).status, 404);
  const imageUrl = `${origin}/raw?${new URLSearchParams({ path: path.join(root, "image.svg") })}`;
  assert.equal((await fetch(imageUrl, { method: "POST", headers: { cookie } })).status, 405);
  for (const asset of ["/view?path=note.md", "/viewer.js?v=1", "/viewer.css?v=1"]) {
    const response = await fetch(origin + asset);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy")!, /object-src 'none'/);
  }
});

async function writeWebRoot(t: test.TestContext, files: Record<string, string>): Promise<string> {
  const webRoot = await mkdtemp(path.join(tmpdir(), "grok-pwa-http-"));
  t.after(() => rm(webRoot, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(webRoot, name), body);
  }
  return webRoot;
}

async function startWeb(
  t: test.TestContext,
  webRoot: string,
): Promise<{ base: string; server: RemoteWebSocketServer }> {
  const harness = emptyServices();
  const server = new RemoteWebSocketServer({
    token: "test-secret-token-value-32chars!!",
    services: harness.services,
    webRoot,
  });
  t.after(async () => {
    await server.close();
    await harness.turns.dispose();
    harness.services.presence.dispose();
  });
  const address = await server.listen(0);
  return { server, base: `http://${address.host}:${address.port}` };
}

const WEB_FILES = {
  "index.html": '<head><script type="module" src="/app.js"></script><link href="/styles.css" rel="stylesheet"></head>mark-A',
  "view.html": '<head><script type="module" src="/viewer.js"></script><link href="/viewer.css" rel="stylesheet"></head>',
  "app.js": 'import "./markdown.js"; window.__PWA_MARK__ = "A";',
  "markdown.js": "// dependency-A",
  "styles.css": "body { color: red }",
  "viewer.js": 'import "./markdown.js";',
  "viewer.css": ".file-viewer {}",
  "boot.js": "// boot",
  "notice.js": "// notice",
  "slash-menu.js": "// menu",
  "manifest.webmanifest": "{}",
  "icon.svg": "<svg></svg>",
  "icon-192.png": "fake png",
  "icon-512.png": "fake png",
  "icon-512-maskable.png": "fake png",
  "sw.js": "// sw-A",
};

const scriptUrl = (html: string) => /src="([^"]+)"/u.exec(html)![1]!;

test("a running server keeps its startup frontend until restart; old module URLs survive the restart", async (t) => {
  const webRoot = await writeWebRoot(t, WEB_FILES);
  const running = await startWeb(t, webRoot);
  const base = running.base;
  const first = await fetch(base);
  assert.match(first.headers.get("cache-control")!, /no-cache/u);
  const firstHtml = await first.text();
  assert.match(firstHtml, /mark-A/u);
  const oldApp = scriptUrl(firstHtml);
  assert.match(oldApp, /^\/assets\/[a-f0-9]{64}\/app.js$/u);
  assert.match(firstHtml, /<meta name="grok-remote-assets"/u);
  const oldModule = new URL("./markdown.js", `${base}${oldApp}`).pathname;
  const asset = await fetch(`${base}${oldApp}`);
  assert.match(asset.headers.get("cache-control")!, /immutable/u);
  assert.match(await asset.text(), /__PWA_MARK__ = "A"/u);
  assert.equal(await (await fetch(`${base}${oldModule}`)).text(), "// dependency-A");
  const view = await (await fetch(`${base}/view`)).text();
  assert.match(view, /\/assets\/[a-f0-9]{64}\/viewer\.js/u);

  // 相当于在运行中的工作树里 git pull：旧进程继续提供启动时的一整套。
  await writeFile(path.join(webRoot, "markdown.js"), "// dependency-B");
  await writeFile(path.join(webRoot, "index.html"), WEB_FILES["index.html"].replace("mark-A", "mark-B"));
  await writeFile(path.join(webRoot, "sw.js"), "// sw-B");
  assert.equal(await (await fetch(base)).text(), firstHtml);
  assert.equal(await (await fetch(`${base}${oldModule}`)).text(), "// dependency-A");
  assert.equal(await (await fetch(`${base}/sw.js`)).text(), "// sw-A");

  await running.server.close();
  const restarted = (await startWeb(t, webRoot)).base;
  const secondHtml = await (await fetch(restarted)).text();
  assert.match(secondHtml, /mark-B/u);
  const newApp = scriptUrl(secondHtml);
  assert.notEqual(newApp, oldApp);
  const newModule = new URL("./markdown.js", `${restarted}${newApp}`).pathname;
  assert.equal(await (await fetch(`${restarted}${newModule}`)).text(), "// dependency-B");
  assert.equal(await (await fetch(`${restarted}${oldModule}`)).text(), "// dependency-A");
  assert.equal(await (await fetch(`${restarted}/sw.js`)).text(), "// sw-B");

  const head = await fetch(`${restarted}${newApp}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await fetch(`${restarted}${newApp.replace("app.js", "config.json")}`)).status, 404);
  assert.equal((await fetch(`${restarted}/assets/${"0".repeat(64)}/app.js`)).status, 404);
  assert.equal((await fetch(`${restarted}/assets/${"0".repeat(64)}/%2e%2e%2findex.html`)).status, 404);
  assert.equal((await fetch(`${restarted}/boot.js`)).status, 200);
  assert.equal((await fetch(`${restarted}/icon.svg`)).status, 200);
});

test("repeated releases keep only the current and two previous snapshots on disk", async (t) => {
  const webRoot = await writeWebRoot(t, WEB_FILES);
  const apps: string[] = [];
  for (let release = 0; release < 4; release += 1) {
    await writeFile(path.join(webRoot, "boot.js"), `// boot ${release}`);
    const { base, server } = await startWeb(t, webRoot);
    const app = scriptUrl(await (await fetch(base)).text());
    apps.push(app);
    await server.close();
    // 发布先后由目录时间决定；这里拉开间隔，不依赖文件系统时间戳精度。
    const at = new Date(Date.now() - (10 - release) * 60_000);
    await utimes(path.join(webRoot, ".web-assets", app.split("/")[2]!), at, at);
  }
  await writeFile(path.join(webRoot, "boot.js"), "// boot current");
  const { base } = await startWeb(t, webRoot);
  const current = scriptUrl(await (await fetch(base)).text());
  const kept = (await readdir(path.join(webRoot, ".web-assets"))).filter((name) => !name.startsWith("."));
  assert.deepEqual(kept.sort(), [current, apps[2]!, apps[3]!].map((url) => url.split("/")[2]!).sort());
  assert.equal((await fetch(`${base}${apps[0]}`)).status, 404);
  assert.equal((await fetch(`${base}${apps[1]}`)).status, 404);
  assert.equal((await fetch(`${base}${apps[2]}`)).status, 200);
  assert.equal((await fetch(`${base}${apps[3]}`)).status, 200);
});

test("storage failures for older versioned assets are not disguised as missing files", async (t) => {
  const webRoot = await writeWebRoot(t, WEB_FILES);
  const previous = await startWeb(t, webRoot);
  const appUrl = scriptUrl(await (await fetch(previous.base)).text());
  await previous.server.close();
  await writeFile(path.join(webRoot, "boot.js"), "// boot next");
  const { base } = await startWeb(t, webRoot);
  const snapshotFile = path.join(webRoot, ".web-assets", appUrl.split("/")[2]!, "app.js");
  await chmod(snapshotFile, 0);
  t.after(() => chmod(snapshotFile, 0o644).catch(() => {}));
  const denied = await fetch(`${base}${appUrl}`);
  assert.equal(denied.status, 500);
});

test("an incomplete frontend fails startup instead of being served or published", async (t) => {
  const webRoot = await writeWebRoot(t, WEB_FILES);
  await rm(path.join(webRoot, "sw.js"));
  await assert.rejects(startWeb(t, webRoot), /Missing public asset: sw\.js/u);
  await assert.rejects(readdir(path.join(webRoot, ".web-assets")), { code: "ENOENT" });
});

function emptyServices(): { services: BrowserConnectionServices; turns: TurnRuntime } {
  const presence = new PresenceTracker();
  const disk = new GrokSessionDisk("/tmp");
  const store = new RemoteSessionStore("/tmp/grok-remote-test-state");
  const turns = new TurnRuntime({
    store,
    projects: { resolve: async () => ({ id: "p", name: "p", rootId: "r", path: "/tmp" }) },
    presence,
    grokBin: "grok",
    spawnAgent: () => {
      throw new Error("测试不应启动 Grok");
    },
  });
  return {
    turns,
    services: {
    projects: {
      async list() {
        return [{ id: "projects/demo", name: "demo", rootId: "projects" }];
      },
    },
    sessions: {
      async list(): Promise<SessionPage> {
        return { sessions: [], marked: [], nextCursor: null };
      },
      async start(): Promise<OpenedSession> {
        throw new Error("未使用");
      },
      async open(): Promise<OpenedSession> {
        throw new Error("未使用");
      },
      async archive(_projectId: string, sessionIds: string[]) {
        return { succeeded: sessionIds, failed: [] };
      },
      async unarchive(_projectId: string, sessionIds: string[]) {
        return { succeeded: sessionIds, failed: [] };
      },
      async moveToTrash(_projectId: string, sessionIds: string[]) {
        return { succeeded: sessionIds, failed: [] };
      },
      async restoreTrash(_projectId: string, sessionIds: string[]) {
        return { succeeded: sessionIds, failed: [] };
      },
      async deleteTrash(_projectId: string, sessionIds: string[]) {
        return { succeeded: sessionIds, failed: [] };
      },
      async setMarked(projectId: string, sessionId: string, marked: boolean) {
        return {
          id: sessionId,
          title: "新会话",
          preview: "",
          createdAt: 1,
          updatedAt: 1,
          state: "idle" as const,
          pending: false,
          projectId,
          projectName: "demo",
          marked,
          deletedAt: null,
          purgeAt: null,
        };
      },
      async ensureMeta() {
        throw new Error("未使用");
      },
    },
    turns,
    commands: new CommandRunner(turns, disk, store),
    locks: new ProjectTaskLocks(turns),
    presence,
    },
  };
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时。`)), 2_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function loginCookie(origin: string): Promise<string> {
  const response = await fetch(`${origin}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "test-secret-token-value-32chars!!" }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}
