import assert from "node:assert/strict";
import test from "node:test";

import { CommandRunner } from "../commands/runner.ts";
import { GrokSessionDisk } from "../sessions/disk.ts";
import { RemoteSessionStore } from "../sessions/store.ts";
import type { BrowserTurnEvent } from "../turns/runtime.ts";
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
      async delete(_projectId, sessionIds) {
        return { succeeded: sessionIds, failed: [] };
      },
    },
    turns,
    commands: new CommandRunner(
      {
        async toggleAlwaysApprove() {
          return turns.toggleAlwaysApprove("");
        },
        async runPrompt() {
          return { turnId: "turn-cmd" };
        },
        cachedModels() {
          return [];
        },
      },
      disk,
      store,
    ),
    locks: new ProjectTaskLocks(),
    presence,
  };
}
