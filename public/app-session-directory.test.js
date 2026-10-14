import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { createSelectionBar } from "./selection-bar.js";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return source.slice(from, to);
}

const plain = (value) => JSON.parse(JSON.stringify(value));

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.id = "";
    this.title = "";
    this.type = "";
    this.className = "";
    this.parentElement = null;
    this.classList = { toggle() {} };
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  emit(name) { return this.listeners[name]?.(); }
  querySelectorAll() { return []; }
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
}

function summary(id, overrides = {}) {
  return {
    id,
    title: id.toUpperCase(),
    projectId: "project-one",
    state: "idle",
    marked: false,
    pending: false,
    ...overrides,
  };
}

function harness({ view = "active", selectionMode = false } = {}) {
  const requests = [];
  const responders = [];
  const notices = [];
  const confirmations = [];
  let confirmAnswer = true;
  const elements = new Proxy({}, {
    get(target, key) {
      if (!target[key]) {
        target[key] = new FakeElement();
        target[key].parentElement = new FakeElement();
      }
      return target[key];
    },
  });
  const context = vm.createContext({
    TEMPORARY_ERROR: { tone: "error" },
    TEMPORARY_WARNING: { tone: "warning" },
    TEMPORARY_INFO: { tone: "info" },
    SESSION_ORGANIZING_BUSY_MESSAGE: "这个项目有正在执行的任务，暂时不能整理会话。",
    state: {
      projectId: "project-one",
      projects: [
        { id: "project-one", name: "One" },
        { id: "project-two", name: "Two" },
      ],
      currentSessionId: null,
      sessionView: view,
      sessions: [],
      markedSessions: [],
      sessionCursor: null,
      sessionLoading: false,
      sessionLoadGeneration: 0,
      navigationBusy: false,
    },
    elements,
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createElementNS: (_namespace, tagName) => new FakeElement(tagName),
    },
    request(type, payload = {}) {
      requests.push({ type, ...payload });
      const respond = responders.shift();
      if (!respond) return Promise.reject(new Error(`unexpected request ${type}`));
      return respond();
    },
    showNotice: (message, options) => notices.push({ message, options }),
    errorMessage: (error) => error.message,
    updateControls() {},
    appendSessionText(container, session) {
      const text = new FakeElement("span");
      text.textContent = session.title || "新会话";
      container.append(text);
    },
    createSessionRename: () => new FakeElement("button"),
    createSessionMark: () => new FakeElement("button"),
    mergeSessions: (existing, incoming) => [...existing, ...incoming],
    keepOpenPendingSession() {},
    resetCurrentSession() { context.state.currentSessionId = null; },
    showEmpty() {},
    resumeSession() {},
    closeMobileSidebar() {},
    trashRemainingText: () => "",
    formatDate: () => "",
  });
  vm.runInContext([
    section("async function loadSessions(", "async function startSession("),
    section("function setSessionView(", "function appendSessionText("),
    section("function visibleSessionSummaries(", "function mergeSessions("),
  ].join("\n"), context);

  const views = {
    active: { actions: [
      { id: "archive", label: "归档", resultLabel: "归档", icon: "archive" },
      { id: "trash-active", label: "删除", resultLabel: "删除", icon: "delete", danger: true, retention: true },
    ] },
    archived: { actions: [
      { id: "unarchive", label: "取消归档", resultLabel: "取消归档", icon: "unarchive" },
      { id: "trash-archived", label: "删除", resultLabel: "删除", icon: "delete", danger: true, retention: true },
    ] },
    trash: { actions: [
      { id: "restore-trash", label: "恢复", resultLabel: "恢复", icon: "restore" },
      { id: "delete-trash", label: "永久删除", resultLabel: "永久删除", icon: "purge", danger: true, permanent: true },
    ] },
  };
  const selectionBar = createSelectionBar({
    container: elements.selectionHeading,
    views,
    initialView: view,
    noun: "会话",
    untitledLabel: "新会话",
    permanentDeleteDetail: "会话原文会一并删除",
    getId: (session) => session.id,
    getTitle: (session) => session.title,
    isSelectable: (session) => context.sessionSelectable(session),
    isPinned: (session) => Boolean(session.marked),
    executeAction: (action, ids) => context.executeSessionSelectionAction(action, ids),
    refreshItems: () => context.loadSessions(),
    confirm: async (message, options) => {
      confirmations.push({ message, options });
      return confirmAnswer;
    },
    notify: (message, tone) => context.showNotice(
      message,
      tone === "error" ? context.TEMPORARY_ERROR : context.TEMPORARY_INFO,
    ),
    onSelectionChange: () => context.renderSessionList(),
    onBusyChange: (busy) => { context.state.navigationBusy = busy; },
    document: context.document,
  });
  context.selectionBar = selectionBar;
  if (selectionMode && view !== "trash") selectionBar.setManualSelection(true);

  return {
    context,
    selectionBar,
    elements,
    requests,
    notices,
    confirmations,
    byId(id) {
      return [elements.selectionHeading, ...elements.selectionHeading.walk()]
        .find((element) => element.id === id);
    },
    respond(result) {
      responders.push(() => result instanceof Error ? Promise.reject(result) : Promise.resolve(result));
    },
    checkboxes() {
      return [...elements.sessionList.walk()].filter((node) => node.type === "checkbox");
    },
    rejectConfirm() { confirmAnswer = false; },
  };
}

test("selection excludes drafts and cross-project pins while select-all skips every pin", async () => {
  const h = harness({ selectionMode: true });
  h.context.state.markedSessions = [
    summary("other", { projectId: "project-two", marked: true }),
    summary("pinned", { marked: true }),
  ];
  h.context.state.sessions = [summary("draft", { pending: true }), summary("a"), summary("b")];
  h.context.renderSessionList();

  const [other, pinned, draft, a, b] = h.checkboxes();
  assert.equal(other.disabled, true);
  assert.equal(pinned.disabled, false);
  assert.equal(draft.disabled, true);
  assert.equal(a.disabled, false);
  assert.equal(b.disabled, false);

  h.byId("selection-select-all-button").emit("click");
  assert.deepEqual(h.selectionBar.selectedIds(), ["a", "b"]);
  assert.equal(h.selectionBar.toggle("other"), false);
  assert.equal(h.selectionBar.toggle("draft"), false);
  assert.equal(h.selectionBar.toggle("pinned"), true);

  h.respond({ succeeded: ["a", "b", "pinned"], failed: [] });
  h.respond({ sessions: [], marked: [], nextCursor: null });
  await h.selectionBar.runAction("archive");
  assert.deepEqual(plain(h.requests[0]), {
    type: "sessions.mutate",
    projectId: "project-one",
    sessionIds: ["a", "b", "pinned"],
    action: "archive",
  });
});

test("a completed refresh reconciles selection before permanent-delete confirmation", async () => {
  const h = harness({ view: "trash" });
  h.context.state.sessions = [summary("a"), summary("b")];
  h.context.renderSessionList();
  h.selectionBar.toggle("a");
  h.selectionBar.toggle("b");

  h.respond({ sessions: [summary("b", { title: "Renamed B" })], marked: [], nextCursor: null });
  await h.context.loadSessions();
  assert.deepEqual(h.selectionBar.selectedIds(), ["b"]);

  h.respond({ succeeded: ["b"], failed: [] });
  h.respond({ sessions: [], marked: [], nextCursor: null });
  await h.selectionBar.runAction("delete-trash");
  assert.deepEqual(h.confirmations.map((entry) => entry.message), [
    "立刻永久删除「Renamed B」。这一步无法撤销，会话原文会一并删除。继续吗？",
  ]);
});

test("trash keeps backend failures selected through the grok-remote adapter", async () => {
  const h = harness({ view: "trash" });
  h.context.state.sessions = [summary("a"), summary("b")];
  h.context.renderSessionList();
  h.selectionBar.toggle("a");
  h.selectionBar.toggle("b");
  h.respond({
    succeeded: ["a"],
    failed: [{ sessionId: "b", message: "这个会话仍在整理。" }],
  });
  h.respond({ sessions: [summary("b")], marked: [], nextCursor: null });
  await h.selectionBar.runAction("restore-trash");

  assert.deepEqual(h.selectionBar.selectedIds(), ["b"]);
  assert.deepEqual(h.notices, [{
    message: "已完成 1 项，1 项失败：这个会话仍在整理。",
    options: { tone: "error" },
  }]);
});

test("busy states disable the bar and checkboxes with the backend reason", () => {
  const disabled = [];
  const checkbox = new FakeElement("input");
  const item = new FakeElement("article");
  item.dataset = { state: "idle", selectable: "true" };
  item.querySelectorAll = (selector) => selector === 'input[type="checkbox"]' ? [checkbox] : [];
  const elements = new Proxy({}, {
    get(target, key) {
      if (!target[key]) target[key] = new FakeElement();
      return target[key];
    },
  });
  elements.sessionList.querySelectorAll = () => [item];
  elements.messageInput.value = "";
  const context = vm.createContext({
    WebSocket: { OPEN: 1 },
    MAX_MESSAGE_ATTACHMENTS: 100,
    SESSION_ORGANIZING_BUSY_MESSAGE: "这个项目有正在执行的任务，暂时不能整理会话。",
    state: {
      socket: { readyState: 1 }, connectionReady: true, currentSessionId: "session",
      projectId: "project-one", sessions: [summary("a")], markedSessions: [],
      sessionView: "active", busy: false, taskRunning: false, navigationBusy: false,
      sessionLoading: false, composerLocksConfirms: false, pendingAttachments: [],
      alwaysApprove: false,
    },
    elements,
    selectionBar: { setDisabled: (...args) => disabled.push(args) },
    readyAttachments: () => [],
    hasUnfinishedUploads: () => false,
  });
  vm.runInContext([
    section("function visibleSessionSummaries(", "function mergeSessions("),
    section("function updateControls()", "function openSidebar()"),
  ].join("\n"), context);

  for (const field of ["busy", "taskRunning"]) {
    context.state.busy = false;
    context.state.taskRunning = false;
    context.state.sessions[0].state = "idle";
    context.state[field] = true;
    context.updateControls();
    assert.deepEqual(plain(disabled.at(-1)), [true, "这个项目有正在执行的任务，暂时不能整理会话。"]);
    assert.equal(checkbox.disabled, true);
    assert.equal(checkbox.title, "这个项目有正在执行的任务，暂时不能整理会话。");
  }

  context.state.busy = false;
  context.state.taskRunning = false;
  context.state.sessions[0].state = "active";
  context.updateControls();
  assert.deepEqual(plain(disabled.at(-1)), [true, "这个项目有正在执行的任务，暂时不能整理会话。"]);
});
