import assert from "node:assert/strict";
import test from "node:test";

import { CommandRunner } from "../commands/runner.ts";
import { GrokSessionDisk } from "../sessions/disk.ts";
import { RemoteSessionStore } from "../sessions/store.ts";
import type { BrowserTurnEvent } from "../turns/runtime.ts";
import type { SessionChangeEvent } from "../sessions/service.ts";
import {
  BrowserConnection,
  type BrowserConnectionServices,
  type BrowserSocket,
  type TurnApi,
} from "./connection.ts";
import { PresenceTracker } from "./presence.ts";
import { ProjectTaskLocks } from "./project-locks.ts";

class FakeSocket implements BrowserSocket {
  readonly messages: unknown[] = [];
  send(data: string): void {
    this.messages.push(JSON.parse(data));
  }
  close(): void {}
}

test("accepts a message and returns accepted without waiting for Grok", async () => {
  const turns = fakeTurns();
  const services = makeServices(turns);
  const socket = new FakeSocket();
  const connection = new BrowserConnection("conn-1", socket, "secret", services);

  connection.receiveText(JSON.stringify({ type: "auth", requestId: "a", token: "secret" }));
  await connection.whenIdle();

  connection.receiveText(JSON.stringify({
    type: "session.start",
    requestId: "s",
    projectId: "projects/demo",
  }));
  await connection.whenIdle();

  connection.receiveText(JSON.stringify({
    type: "message.send",
    requestId: "m",
    text: "hello",
    clientMessageId: "c1",
  }));
  await connection.whenIdle();

  const response = socket.messages.find((item) =>
    typeof item === "object" && item !== null &&
    (item as { requestId?: string }).requestId === "m"
  ) as { ok: boolean; data: { accepted: boolean; turnId: string } };
  assert.equal(response.ok, true);
  assert.equal(response.data.accepted, true);
  assert.equal(typeof response.data.turnId, "string");
  await connection.disconnect();
  services.presence.dispose();
});

test("creates upload tickets from the authenticated open session binding", async () => {
  const services = makeServices(fakeTurns());
  let received: unknown;
  services.uploads = {
    async createTicket(input) {
      received = input;
      return {
        ticket: "one-time-ticket",
        expiresAtMs: 10,
        attachment: { ...input },
      };
    },
  };
  const socket = new FakeSocket();
  const connection = new BrowserConnection("conn-1", socket, "secret", services);
  connection.receiveText(JSON.stringify({ type: "auth", requestId: "a", token: "secret" }));
  connection.receiveText(JSON.stringify({
    type: "session.start",
    requestId: "s",
    projectId: "projects/demo",
  }));
  connection.receiveText(JSON.stringify({
    type: "attachment.ticket.create",
    requestId: "ticket",
    originalName: "../screen.png",
    declaredMime: "image/png",
    expectedSize: 123,
  }));
  await connection.whenIdle();

  assert.deepEqual(received, {
    caller: "grok",
    projectId: "projects/demo",
    sessionId: "pending-1",
    originalName: "../screen.png",
    declaredMime: "image/png",
    expectedSize: 123,
  });
  const response = socket.messages.find((item) =>
    typeof item === "object" && item !== null &&
    (item as { requestId?: string }).requestId === "ticket"
  ) as { ok: boolean; data: { ticket: string } };
  assert.equal(response.ok, true);
  assert.equal(response.data.ticket, "one-time-ticket");
  await connection.disconnect();
  services.presence.dispose();
});

test("redacts missing authentication", async () => {
  const services = makeServices(fakeTurns());
  const socket = new FakeSocket();
  const connection = new BrowserConnection("conn-1", socket, "secret", services);
  connection.receiveText(JSON.stringify({ type: "projects.list", requestId: "p" }));
  await connection.whenIdle();
  const message = socket.messages[0] as { error?: { code: string } };
  assert.equal(message.error?.code, "not_authenticated");
  await connection.disconnect();
  services.presence.dispose();
});

test("archives an open session and notifies every connected device", async () => {
  const turns = fakeTurns();
  const listeners: Array<(event: SessionChangeEvent) => void> = [];
  const services = makeServices(turns);
  services.sessions = {
    ...services.sessions,
    async archive(_projectId, sessionIds) {
      const event = { projectId: "projects/demo", sessionIds, change: "archive" as const };
      for (const listener of listeners) listener(event);
      return { succeeded: sessionIds, failed: [] };
    },
    onChange(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();
  const first = new BrowserConnection("first", firstSocket, "secret", services);
  const second = new BrowserConnection("second", secondSocket, "secret", services);

  first.receiveText(JSON.stringify({ type: "auth", requestId: "a1", token: "secret" }));
  second.receiveText(JSON.stringify({ type: "auth", requestId: "a2", token: "secret" }));
  first.receiveText(JSON.stringify({
    type: "session.start",
    requestId: "s1",
    projectId: "projects/demo",
  }));
  await first.whenIdle();
  await second.whenIdle();

  first.receiveText(JSON.stringify({
    type: "sessions.mutate",
    requestId: "m1",
    projectId: "projects/demo",
    sessionIds: ["pending-1"],
    action: "archive",
  }));
  await first.whenIdle();
  await second.whenIdle();

  const firstEvent = firstSocket.messages.find((item) =>
    typeof item === "object" && item !== null &&
    (item as { type?: string }).type === "event" &&
    (item as { event?: { type?: string } }).event?.type === "session.changed"
  ) as { event: { change: string; sessionIds: string[] } };
  const secondEvent = secondSocket.messages.find((item) =>
    typeof item === "object" && item !== null &&
    (item as { type?: string }).type === "event" &&
    (item as { event?: { type?: string } }).event?.type === "session.changed"
  ) as { event: { change: string; sessionIds: string[] } };
  assert.equal(firstEvent.event.change, "archive");
  assert.deepEqual(firstEvent.event.sessionIds, ["pending-1"]);
  assert.equal(secondEvent.event.change, "archive");

  first.receiveText(JSON.stringify({
    type: "message.send",
    requestId: "after-archive",
    text: "不应发送",
    clientMessageId: "c-after",
  }));
  await first.whenIdle();
  const response = firstSocket.messages.find((item) =>
    typeof item === "object" && item !== null &&
    (item as { requestId?: string }).requestId === "after-archive"
  ) as { ok: boolean };
  assert.equal(response.ok, false);

  await first.disconnect();
  await second.disconnect();
  services.presence.dispose();
});

test("releases the project lock after a synchronous session command", async () => {
  const services = makeServices(fakeTurns());
  const socket = new FakeSocket();
  const connection = new BrowserConnection("conn-1", socket, "secret", services);

  connection.receiveText(JSON.stringify({ type: "auth", requestId: "a", token: "secret" }));
  connection.receiveText(JSON.stringify({
    type: "session.start",
    requestId: "s",
    projectId: "projects/demo",
  }));
  connection.receiveText(JSON.stringify({
    type: "command.run",
    requestId: "c",
    command: "context",
    option: null,
    argument: null,
  }));
  await connection.whenIdle();

  const response = socket.messages.find((item) =>
    typeof item === "object" && item !== null &&
    (item as { requestId?: string }).requestId === "c"
  ) as { ok: boolean };
  assert.equal(response.ok, true);
  assert.equal(services.locks.acquire("projects/demo", "conn-2", "other"), true);
  services.locks.release("projects/demo", "conn-2");
  await connection.disconnect();
  services.presence.dispose();
});

function fakeTurns(): TurnApi {
  const listeners = new Set<(event: BrowserTurnEvent) => void>();
  return {
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async sendMessage(input) {
      return {
        accepted: true,
        turnId: "turn-1",
        sessionId: input.sessionId,
        clientMessageId: input.clientMessageId,
      };
    },
    async stop() {},
    async toggleAlwaysApprove() {
      return { enabled: true };
    },
    async answerApproval() {
      return true;
    },
    async eventsSince() {
      return [];
    },
    pendingApprovals() {
      return [];
    },
    activeTurnId() {
      return null;
    },
  };
}

function makeServices(turns: TurnApi): BrowserConnectionServices {
  const presence = new PresenceTracker();
  const disk = new GrokSessionDisk("/tmp");
  const store = new RemoteSessionStore("/tmp/grok-remote-conn-test");
  const opened = {
    session: {
      id: "pending-1",
      title: "新会话",
      preview: "",
      createdAt: 1,
      updatedAt: 1,
      state: "idle" as const,
      pending: true,
      deletedAt: null,
      purgeAt: null,
    },
    tasks: [],
    older: [],
    activeTurnId: null,
    alwaysApprove: false,
    lastSeq: 0,
    resumeAfterSeq: 0,
  };
  return {
    projects: {
      async list() {
        return [{ id: "projects/demo", name: "demo", rootId: "projects" }];
      },
    },
    sessions: {
      async list() {
        return { sessions: [], nextCursor: null };
      },
      async start() {
        return opened;
      },
      async open() {
        return opened;
      },
      async archive(_projectId, sessionIds) {
        return { succeeded: sessionIds, failed: [] };
      },
      async unarchive(_projectId, sessionIds) {
        return { succeeded: sessionIds, failed: [] };
      },
      async moveToTrash(_projectId, sessionIds) {
        return { succeeded: sessionIds, failed: [] };
      },
      async restoreTrash(_projectId, sessionIds) {
        return { succeeded: sessionIds, failed: [] };
      },
    },
    turns,
    commands: new CommandRunner(
      {
        async toggleAlwaysApprove() {
          return turns.toggleAlwaysApprove("");
        },
        cachedModels() {
          return [];
        },
        async inspectSession() {
          return { sessionId: "pending-1" };
        },
        async setModel(_sessionId, modelId, reasoningEffort) {
          return { sessionId: "pending-1", modelId, reasoningEffort };
        },
        async setEffort(_sessionId, reasoningEffort) {
          return { sessionId: "pending-1", modelId: "grok", reasoningEffort };
        },
        async enterPlan() {
          return { sessionId: "pending-1" };
        },
        async renameSession(_sessionId, title) {
          return { sessionId: "pending-1", title };
        },
        async compact() {
          return { turnId: "turn-cmd" };
        },
        async rewind() {
          return { kind: "rewind" as const, sessionId: "pending-1", promptText: null };
        },
      },
      disk,
      store,
    ),
    locks: new ProjectTaskLocks(),
    presence,
  };
}
