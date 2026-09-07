import assert from "node:assert/strict";
import test from "node:test";

import { parseBrowserRequest, ProtocolError } from "./protocol.ts";

test("parses the grok-remote browser protocol", () => {
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "sessions.list",
    requestId: "sessions-1",
    projectId: "projects/demo",
    view: "archived",
    searchTerm: "测试",
  })), {
    type: "sessions.list",
    requestId: "sessions-1",
    projectId: "projects/demo",
    cursor: null,
    view: "archived",
    searchTerm: "测试",
  });

  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "session.mark",
    requestId: "mark-1",
    projectId: "projects/demo",
    sessionId: "session-1",
    marked: true,
  })), {
    type: "session.mark",
    requestId: "mark-1",
    projectId: "projects/demo",
    sessionId: "session-1",
    marked: true,
  });

  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "session.rename",
    requestId: "rename-1",
    projectId: "projects/demo",
    sessionId: "session-1",
    title: "  新名字  ",
  })), {
    type: "session.rename",
    requestId: "rename-1",
    projectId: "projects/demo",
    sessionId: "session-1",
    title: "新名字",
  });

  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "sessions.mutate",
    requestId: "sessions-2",
    projectId: "projects/demo",
    sessionIds: ["session-1", "session-1", "session-2"],
    action: "trash-active",
  })), {
    type: "sessions.mutate",
    requestId: "sessions-2",
    projectId: "projects/demo",
    sessionIds: ["session-1", "session-2"],
    action: "trash-active",
  });

  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "sessions.mutate",
    requestId: "sessions-3",
    projectId: "projects/demo",
    sessionIds: ["session-1"],
    action: "delete-trash",
  })), {
    type: "sessions.mutate",
    requestId: "sessions-3",
    projectId: "projects/demo",
    sessionIds: ["session-1"],
    action: "delete-trash",
  });

  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "message.send",
    requestId: "m1",
    text: "hello",
    clientMessageId: "client-1",
  })), {
    type: "message.send",
    requestId: "m1",
    text: "hello",
    clientMessageId: "client-1",
    attachmentIds: [],
  });

  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "message.send",
    requestId: "m2",
    text: "",
    clientMessageId: "client-2",
    attachmentIds: ["attachment-1", "attachment-1", "attachment-2"],
  })), {
    type: "message.send",
    requestId: "m2",
    text: "",
    clientMessageId: "client-2",
    attachmentIds: ["attachment-1", "attachment-2"],
  });

  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "attachment.ticket.create",
    requestId: "ticket-1",
    originalName: "screen.png",
    declaredMime: "image/png",
    expectedSize: 123,
  })), {
    type: "attachment.ticket.create",
    requestId: "ticket-1",
    originalName: "screen.png",
    declaredMime: "image/png",
    expectedSize: 123,
  });

  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "command.run",
    requestId: "c1",
    command: "status",
    option: null,
    argument: null,
  })), {
    type: "command.run",
    requestId: "c1",
    command: "session-info",
    option: null,
    argument: null,
  });

  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "events.resume",
    requestId: "e1",
    afterSeq: 12,
  })), {
    type: "events.resume",
    requestId: "e1",
    afterSeq: 12,
  });
});

test("rejects missing clientMessageId and Codex-only commands", () => {
  assert.throws(
    () => parseBrowserRequest(JSON.stringify({
      type: "message.send",
      requestId: "m",
      text: "hello",
    })),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_field",
  );

  assert.throws(
    () => parseBrowserRequest(JSON.stringify({
      type: "command.run",
      requestId: "c",
      command: "usage",
    })),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "unknown_command",
  );
});

test("rejects empty, multiline, and oversized session titles", () => {
  assert.throws(
    () => parseBrowserRequest(JSON.stringify({
      type: "session.rename",
      requestId: "r1",
      projectId: "projects/demo",
      sessionId: "session-1",
      title: "   ",
    })),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_field" &&
      error.message === "会话名称不能为空。",
  );

  assert.throws(
    () => parseBrowserRequest(JSON.stringify({
      type: "session.rename",
      requestId: "r2",
      projectId: "projects/demo",
      sessionId: "session-1",
      title: "一行\n两行",
    })),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_field" &&
      error.message === "会话名称不能包含换行。",
  );

  assert.throws(
    () => parseBrowserRequest(JSON.stringify({
      type: "session.rename",
      requestId: "r3",
      projectId: "projects/demo",
      sessionId: "session-1",
      title: "名".repeat(161),
    })),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_field" &&
      error.message === "会话名称太长。",
  );
});
