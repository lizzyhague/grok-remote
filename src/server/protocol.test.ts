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
    type: "message.send",
    requestId: "m1",
    text: "hello",
    clientMessageId: "client-1",
  })), {
    type: "message.send",
    requestId: "m1",
    text: "hello",
    clientMessageId: "client-1",
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
