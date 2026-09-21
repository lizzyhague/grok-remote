import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { createNoticeController } from "./notice.js";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");

function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeTarget {
  hidden = false;
  disabled = false;
  textContent = "";
  dataset = {};
  children = [];
  #listeners = new Map();

  contains(target) {
    return target === this || this.children.includes(target);
  }

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }
}

function approvalHarness() {
  const notice = new FakeTarget();
  const noticeText = new FakeTarget();
  const actionButton = new FakeTarget();
  const closeButton = new FakeTarget();
  notice.children.push(actionButton, closeButton);
  const document = new FakeTarget();
  document.visibilityState = "visible";
  const noticeController = createNoticeController({
    element: notice,
    textElement: noticeText,
    actionButton,
    closeButton,
    document,
  });
  const approvalList = new FakeTarget();
  approvalList.children.push({ approvalId: "approval-1" });
  const context = vm.createContext({
    WAITING_APPROVAL_NOTICE: "正在等待审批。",
    TEMPORARY_WARNING: { lifetime: "temporary", tone: "warning" },
    NOTICE_DURATION_MS: { undo: 10_000 },
    state: { currentSessionId: "session-1" },
    elements: { approvalList },
    noticeController,
  });
  vm.runInContext(
    section("function syncApprovalNotice()", "function closeSocket()"),
    context,
  );
  return { context, noticeController, notice, approvalList };
}

test("a dismissed approval notice stays hidden until approvals are cleared", () => {
  const h = approvalHarness();
  h.context.syncApprovalNotice();
  assert.equal(h.noticeController.current?.key, "approval:session-1");

  h.noticeController.dismissCurrent();
  h.context.syncApprovalNotice();
  assert.equal(h.notice.hidden, true);

  h.approvalList.children.length = 0;
  h.context.syncApprovalNotice();
  h.approvalList.children.push({ approvalId: "approval-2" });
  h.context.syncApprovalNotice();
  assert.equal(h.notice.hidden, false);
  assert.equal(h.noticeController.current?.key, "approval:session-1");
});

test("waiting status uses the same approval key as approval synchronization", () => {
  const shown = [];
  const context = vm.createContext({
    WAITING_APPROVAL_NOTICE: "正在等待审批。",
    state: {
      currentSessionId: "session-1",
      lastSeq: 0,
      taskRunning: true,
      assistantStreams: new Map(),
    },
    showNotice: (text, options) => shown.push({ text, options }),
    approvalNoticeKey: (sessionId = "session-1") => `approval:${sessionId}`,
    hideThinking() {},
    updateControls() {},
  });
  vm.runInContext(section("function handleServerEvent(", "function addMessage("), context);
  context.handleServerEvent({
    type: "turn.status",
    seq: 4,
    status: "waiting_for_permission",
  });
  assert.deepEqual(plain(shown), [{
    text: "正在等待审批。",
    options: {
      lifetime: "state",
      tone: "warning",
      key: "approval:session-1",
    },
  }]);
});

function outboxHarness(request) {
  const shown = [];
  const clearedNotices = [];
  const removed = [];
  const outbox = {
    projectId: "project-1",
    sessionId: "session-1",
    clientMessageId: "message-1",
    text: "hello",
    attachmentIds: [],
  };
  const context = vm.createContext({
    WebSocket: { OPEN: 1 },
    state: {
      socket: { readyState: 1 },
      projectId: "project-1",
      currentSessionId: "session-1",
    },
    loadOutbox: () => [outbox],
    request,
    clearOutbox: (id) => removed.push(id),
    clearNotice: (key) => clearedNotices.push(key),
    showNotice: (text, options) => shown.push({ text, options }),
    deliveryNoticeKey: (id) => `delivery:${id}`,
    errorMessage: (error) => error.message,
  });
  vm.runInContext(
    section("async function retryOutboxForCurrentSession()", "function createClientMessageId("),
    context,
  );
  return { context, shown, clearedNotices, removed };
}

test("a successful outbox retry clears its delivery state", async () => {
  const h = outboxHarness(async () => ({ accepted: true }));
  await h.context.retryOutboxForCurrentSession();
  assert.deepEqual(h.removed, ["message-1"]);
  assert.deepEqual(h.clearedNotices, ["delivery:message-1"]);
  assert.deepEqual(h.shown, []);
});

test("a definitive outbox failure replaces delivery state with a persistent error", async () => {
  const h = outboxHarness(async () => {
    throw Object.assign(new Error("后端拒绝。"), { code: "rejected" });
  });
  await h.context.retryOutboxForCurrentSession();
  assert.deepEqual(h.removed, ["message-1"]);
  assert.deepEqual(h.clearedNotices, ["delivery:message-1"]);
  assert.deepEqual(plain(h.shown), [{
    text: "保留消息重试失败：后端拒绝。",
    options: {
      lifetime: "persistent",
      tone: "error",
      key: "delivery:message-1",
    },
  }]);
});

test("leaving a session clears only approval and delivery context notices", () => {
  const h = approvalHarness();
  h.noticeController.show("等待审批", {
    lifetime: "state",
    tone: "warning",
    key: "approval:session-1",
  });
  h.context.clearCurrentSessionNotice("session-1");
  assert.equal(h.notice.hidden, true);

  h.noticeController.show("其他长期提示", {
    lifetime: "persistent",
    tone: "warning",
    key: "host-state",
  });
  h.context.clearCurrentSessionNotice("session-1");
  assert.equal(h.noticeController.current?.key, "host-state");
});
