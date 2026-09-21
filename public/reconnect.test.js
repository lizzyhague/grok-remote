import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Execute the production connection, draft and replay functions together.
// Only browser APIs, server responses and unrelated UI rendering are substituted.
function harness() {
  const sockets = [], requests = [], uploads = [], frames = new Map(), storage = new Map();
  const counters = { cleared: 0, histories: 0, noticeSessions: [] };
  const timeline = {
    scrollTop: 420, scrollHeight: 2000, clientHeight: 500, scrolls: [],
    scrollTo(options) { this.scrolls.push(options); this.scrollTop = options.top; },
  };
  let nextId = 0;
  const context = vm.createContext({
    URL, URLSearchParams, AbortController,
    window: { clearTimeout() {} },
    location: { protocol: "https:", host: "example.test", search: "" },
    MAX_MESSAGE_ATTACHMENTS: 100, ATTACHMENT_DRAFTS_KEY: "drafts",
    TEMPORARY_ERROR: { lifetime: "temporary", tone: "error" },
    state: {
      connectAttempt: 0, socket: null, connectionReady: false, replayingEvents: false,
      currentSessionId: "session-1", projectId: "project-1", lastSeq: 7,
      pendingAttachments: [], attachmentUploads: new Map(), assistantStreams: new Map(),
      pendingUserMessages: new Map(), commands: new Map(), liveAssistant: null,
    },
    elements: {
      tokenInput: { value: "" }, loginStatus: {}, connectionStatus: { dataset: {} },
      loginView: {}, appView: {}, timeline,
      approvalList: { replaceChildren() {} }, messageInput: { value: "draft text" },
    },
    fetch: async (url, options) => {
      if (url !== "/attachments/upload") return { ok: true, status: 200 };
      uploads.push(options);
      return { ok: true, json: async () => ({ attachment: { id: "uploaded-2", originalName: options.body.name } }) };
    },
    request: async (type, payload) => {
      requests.push({ type, payload });
      if (type === "session.resume") return { session: { id: "session-1" } };
      if (type === "events.resume") return { events: [] };
      if (type === "attachment.ticket.create") return { ticket: "test-ticket" };
      throw new Error(`Unexpected request: ${type}`);
    },
    WebSocket: class {
      static OPEN = 1;
      readyState = 0;
      listeners = {};
      constructor() { sockets.push(this); }
      addEventListener(name, handler) { this.listeners[name] = handler; }
      open() { this.readyState = 1; this.listeners.open(); }
      close() { this.readyState = 3; this.listeners.close?.(); }
    },
    createClientMessageId: () => `client-${++nextId}`,
    stateGet: (key) => storage.get(key),
    stateSet: (key, value) => storage.set(key, value),
    removeStored: (key) => storage.delete(key),
    loadProjects: async () => {}, ensureSlashMenu: async () => {},
    rejectPending() {}, handleSocketMessage() {}, scheduleReconnect() {},
    updateControls() {}, renderAttachmentList() {}, updateConversationTitle() {},
    renderSessionList() {}, upsertSession() {}, addApproval() {},
    clearCurrentSessionNotice(sessionId) { counters.noticeSessions.push(sessionId); },
    syncApprovalNotice() {}, showNotice() {}, showLogin() {},
    showEmpty() {}, clearTimeline() { counters.cleared++; timeline.scrollTop = 0; },
    renderHistory() { counters.histories++; }, retryOutboxForCurrentSession: async () => {},
    errorMessage: (error) => error.message,
    hideThinking() {}, hideEmpty() {},
    renderMarkdown: (text) => ({ text }),
    requestAnimationFrame: (callback) => { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    addMessage(role, text, id) {
      const element = { classList: { add() {}, remove() {} }, replaceChildren(node) { this.rendered = node; } };
      context.state.assistantStreams.set(id, {
        itemId: id, element, textElement: { textContent: text }, target: text,
        shown: text, completed: false, markdownRendered: false, frame: null,
      });
    },
  });
  const names = [
    "connect", "closeSocket", "showApp", "resetCurrentSession", "setConnectionStatus",
    "restoreSessionAfterReconnect", "applyResumedSessionInPlace", "applyOpenedSession",
    "uploadFiles", "uploadFile", "startUpload", "flushQueuedAttachments", "abortAttachmentUploads",
    "readyAttachments", "attachmentDraftKey", "persistCurrentAttachmentDraft", "loadAttachmentDrafts",
    "loadAttachmentDraftForCurrentSession", "publicAttachments", "replayServerEvents",
    "handleServerEvent", "appendAssistantDelta", "completeAssistant", "finishAssistant",
    "scheduleAssistantFrame", "isNearBottom", "scrollToBottom",
  ];
  for (const name of names) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
    assert.ok(start >= 0, name);
    const tail = source.slice(start);
    const next = tail.slice(1).search(/^(?:async )?function \w+\(/m);
    vm.runInContext(next < 0 ? tail : tail.slice(0, next + 1), context);
  }
  const first = { id: "uploaded-1", originalName: "first.png", status: "ready" };
  context.state.pendingAttachments.push(first);
  context.persistCurrentAttachmentDraft();
  return { context, sockets, requests, uploads, frames, storage, counters, timeline, first };
}

for (const timing of ["before socket opens", "while session is restoring"]) {
  test(`second attachment picked ${timing} survives reconnect and uploads after session resume`, async () => {
    const h = harness();
    const { context, sockets } = h;
    const gate = deferred();
    context.loadProjects = () => gate.promise;
    await context.connect();
    if (timing === "while session is restoring") sockets[0].open();
    const file = { name: "second.png", size: 5, type: "image/png" };
    await context.uploadFiles([file]);
    const second = context.state.pendingAttachments[1];
    assert.equal(second.status, "queued");
    assert.equal(second.file, file);
    assert.equal(h.uploads.length, 0);
    if (timing === "before socket opens") sockets[0].open();
    gate.resolve();
    await tick();
    assert.equal(context.state.pendingAttachments[0], h.first);
    assert.equal(context.state.pendingAttachments[1], second);
    assert.equal(second.status, "ready");
    assert.equal(h.uploads.length, 1);
    assert.equal(h.uploads[0].body, file);
    const types = h.requests.map((request) => request.type);
    assert.ok(types.indexOf("session.resume") < types.indexOf("attachment.ticket.create"));
    assert.equal(context.state.connectionReady, true);
    assert.equal(h.counters.cleared, 0);
    assert.equal(h.counters.histories, 0);
    assert.equal(h.timeline.scrollTop, 420);
    assert.equal(context.elements.messageInput.value, "draft text");
    assert.equal(JSON.parse(h.storage.get("drafts"))["project-1\nsession-1"].length, 2);
  });
}

test("reconnect preserves an HTTP upload already in progress without uploading twice", async () => {
  const h = harness();
  await h.context.connect();
  h.sockets[0].open();
  await tick();
  const upload = deferred();
  const fetch = h.context.fetch;
  h.context.fetch = (url, options) => url === "/attachments/upload" ? upload.promise : fetch(url, options);
  const picked = h.context.uploadFiles([{ name: "second.png", size: 5 }]);
  await tick();
  const second = h.context.state.pendingAttachments[1];
  const controller = h.context.state.attachmentUploads.get(second.clientId);
  await h.context.connect();
  h.sockets[1].open();
  await tick();
  assert.equal(controller.signal.aborted, false);
  assert.equal(h.context.state.pendingAttachments[1], second);
  assert.equal(h.requests.filter((r) => r.type === "attachment.ticket.create").length, 1);
  upload.resolve({ ok: true, json: async () => ({ attachment: { id: "uploaded-2" } }) });
  await picked;
  assert.equal(second.status, "ready");
});

test("another disconnect during session resume keeps the queued file for the next connection", async () => {
  const h = harness();
  const resume = deferred();
  const request = h.context.request;
  h.context.request = (type, payload) => type === "session.resume" ? resume.promise : request(type, payload);
  await h.context.uploadFiles([{ name: "second.png", size: 5 }]);
  const second = h.context.state.pendingAttachments[1];
  await h.context.connect();
  h.sockets[0].open();
  await tick();
  h.sockets[0].close();
  resume.reject(new Error("Connection lost"));
  await tick();
  assert.equal(h.context.state.pendingAttachments[1], second);
  assert.equal(second.status, "queued");
  assert.equal(h.counters.cleared, 0);
  h.context.request = request;
  await h.context.connect();
  h.sockets[1].open();
  await tick();
  assert.equal(second.status, "ready");
});

test("a stale session response cannot replace a newer connection's session", async () => {
  const h = harness();
  const resume = deferred();
  const request = h.context.request;
  h.context.request = (type, payload) => type === "session.resume" ? resume.promise : request(type, payload);
  await h.context.connect();
  h.sockets[0].open();
  await tick();
  await h.context.connect();
  h.context.state.currentSessionId = "session-2";
  resume.resolve({ session: { id: "session-1" } });
  await tick();
  assert.equal(h.context.state.currentSessionId, "session-2");
  assert.equal(h.context.state.connectionReady, false);
  assert.equal(h.counters.histories, 0);
});

test("opening another session clears only the previous session notice context", () => {
  const h = harness();
  h.context.applyOpenedSession({
    session: { id: "session-2" },
    tasks: [],
    pendingApprovals: [],
    lastSeq: 0,
    resumeAfterSeq: 0,
  });
  assert.deepEqual(h.counters.noticeSessions, ["session-1"]);
  assert.equal(h.context.state.currentSessionId, "session-2");
});

for (const atBottom of [false, true]) {
  test(`missed reply displays immediately and ${atBottom ? "follows the bottom instantly" : "preserves the reading position"}`, () => {
    const h = harness();
    if (atBottom) h.timeline.scrollTop = 1500;
    // A pre-disconnect frame may still be pending when the missed events arrive.
    h.context.appendAssistantDelta("reply-1", "Before. ");
    h.timeline.scrollTop = atBottom ? 1500 : 420;
    assert.equal(h.frames.size, 1);
    h.context.replayServerEvents([
      { type: "message.delta", itemId: "reply-1", text: "After." },
      { type: "message.completed", itemId: "reply-1", text: "Before. After." },
    ]);
    const stream = h.context.state.assistantStreams.get("reply-1");
    assert.equal(stream.element.rendered.text, "Before. After.");
    assert.equal(stream.markdownRendered, true);
    assert.equal(h.frames.size, 0);
    assert.equal(h.timeline.scrollTop, atBottom ? 2000 : 420);
    assert.equal(h.timeline.scrolls.length, 1);
    assert.equal(h.timeline.scrolls[0].behavior, "instant");
    assert.equal(h.counters.cleared, 0);
    assert.equal(h.context.state.replayingEvents, false);
  });
}

test("catching up an unfinished reply displays received text and allows subsequent live animation", () => {
  const h = harness();
  h.context.replayServerEvents([{ type: "message.delta", itemId: "reply-1", text: "Already received" }]);
  const stream = h.context.state.assistantStreams.get("reply-1");
  assert.equal(stream.textElement.textContent, "Already received");
  assert.equal(stream.shown, "Already received");
  assert.equal(h.frames.size, 0);
  h.context.appendAssistantDelta("reply-1", " and new text");
  assert.equal(h.frames.size, 1);
});

test("initial connection without a session still initializes the empty view", async () => {
  const h = harness();
  h.context.state.currentSessionId = null;
  h.context.state.pendingAttachments = [];
  await h.context.connect();
  h.sockets[0].open();
  await tick();
  assert.equal(h.counters.cleared, 1);
  assert.equal(h.context.state.connectionReady, true);
  assert.equal(h.requests.some((r) => r.type === "session.resume"), false);
});
