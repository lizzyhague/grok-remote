import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

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

test("serves health and authenticated WebSocket only on loopback", async () => {
  const harness = emptyServices();
  const { services } = harness;
  const server = new RemoteWebSocketServer({
    token: "test-secret-token-value-32chars!!",
    services,
    authTimeoutMs: 2_000,
  });
  const address = await server.listen(0);
  const webSocket = new WebSocket(`ws://${address.host}:${address.port}/ws`);
  const opened = once(webSocket, "open");

  try {
    const health = await fetch(`http://${address.host}:${address.port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const page = await fetch(`http://${address.host}:${address.port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Grok Remote/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);

    for (const asset of ["/boot.js", "/markdown.js", "/slash-menu.js"]) {
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
      type: "auth",
      requestId: "auth-1",
      token: "test-secret-token-value-32chars!!",
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
    authTimeoutMs: 2_000,
    allowedOrigins: ["https://vps.example.ts.net"],
  });
  const address = await server.listen(0);
  const url = `ws://${address.host}:${address.port}/ws`;

  try {
    const attacker = new WebSocket(url, {
      headers: { origin: "https://attacker.example" },
    });
    const rejected = await withTimeout(
      once(attacker, "error").then(() => "rejected" as const),
      "等待跨站连接被拒绝",
    );
    assert.equal(rejected, "rejected");

    const sameOrigin = new WebSocket(url, {
      headers: { origin: `http://${address.host}:${address.port}` },
    });
    await withTimeout(once(sameOrigin, "open"), "打开同源 WebSocket");
    sameOrigin.close();

    const proxied = new WebSocket(url, {
      headers: { origin: "https://vps.example.ts.net" },
    });
    await withTimeout(once(proxied, "open"), "打开白名单来源的 WebSocket");
    proxied.close();

    const headless = new WebSocket(url);
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
  try {
    const uploaded = await fetch(`${origin}/attachments/upload`, {
      method: "POST",
      headers: { origin, "x-upload-ticket": "ticket-secret" },
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
          marked,
          deletedAt: null,
          purgeAt: null,
        };
      },
    },
    turns,
    commands: new CommandRunner(turns, disk, store),
    locks: new ProjectTaskLocks(),
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
