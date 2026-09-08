import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const connect = source.slice(source.indexOf("async function connect("), source.indexOf("function handleSocketMessage("));

function harness(fetch, search = "") {
  const sockets = [];
  const actions = [];
  const context = vm.createContext({
    fetch, URL, URLSearchParams,
    location: { protocol: "https:", host: "example.com", origin: "https://example.com", search,
      replace: (href) => actions.push(["redirect", href]) },
    state: { connectAttempt: 0, currentSessionId: "session-1" },
    elements: { tokenInput: { value: "" }, loginStatus: {} },
    closeSocket() { context.state.socket = null; },
    showLogin: () => actions.push(["login"]),
    showApp: () => actions.push(["app"]),
    setConnectionStatus() {},
    updateControls() {},
    flushQueuedAttachments: async () => {},
    scheduleReconnect: () => actions.push(["retry"]),
    errorMessage: (error) => error.message,
    loadProjects: async () => actions.push(["projects"]),
    ensureSlashMenu: async () => {},
    restoreSessionAfterReconnect: async (id) => actions.push(["restore", id]),
    rejectPending() {}, handleSocketMessage() {},
    WebSocket: class {
      static OPEN = 1;
      readyState = 1;
      listeners = {};
      constructor(url) { this.url = url; sockets.push(this); }
      addEventListener(name, listener) { this.listeners[name] = listener; }
    },
  });
  vm.runInContext(connect, context);
  return { context, sockets, actions };
}

test("cookie login opens WebSocket without an auth frame, reconnect restores the session", async () => {
  const requests = [];
  const { context, sockets, actions } = harness(async (url, options) => {
    requests.push({ url, options });
    return new Response("{}", { status: 200 });
  });
  await context.connect("test-credential");
  assert.equal(requests[0].url, "/auth/login");
  assert.equal(JSON.parse(requests[0].options.body).token, "test-credential");
  assert.equal(context.elements.tokenInput.value, "");
  sockets[0].listeners.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(actions.some(([action, id]) => action === "restore" && id === "session-1"));
  await context.connect();
  assert.equal(requests[1].url, "/auth/session");
  assert.equal(requests[1].options.body, undefined);
  const before = actions.length;
  sockets[0].listeners.close();
  assert.equal(actions.length, before, "stale connection must not reconnect");
});

test("missing cookies prompt login and do not enter a reconnect loop", async () => {
  const { context, sockets, actions } = harness(async () => new Response(null, { status: 401 }));
  await context.connect();
  assert.equal(sockets.length, 0);
  assert.equal(context.state.reconnectEnabled, false);
  assert.deepEqual(actions, [["login"]]);
});

test("successful login returns to a same-origin viewer only", async () => {
  for (const target of ["/view?path=demo%2Fnote.md", "https://attacker.example/view?path=note.md", "//attacker.example/view?path=note.md"]) {
    const { context, actions } = harness(async () => new Response("{}"), `?${new URLSearchParams({ returnTo: target })}`);
    await context.connect();
    assert.equal(actions.some(([action]) => action === "redirect"), target.startsWith("/view?"));
  }
});
