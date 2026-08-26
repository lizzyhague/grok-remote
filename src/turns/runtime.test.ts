import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ProjectCatalog } from "../projects/catalog.ts";
import { RemoteSessionStore } from "../sessions/store.ts";
import { PresenceTracker } from "../server/presence.ts";
import type { SpawnedAgent } from "../worker/process.ts";
import { TurnRuntime } from "./runtime.ts";

test("duplicate clientMessageId returns the same accepted turn", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "grok-remote-turn-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "demo"), { recursive: true });
  const catalog = await ProjectCatalog.fromRoots([{ id: "projects", path: root }]);
  const store = new RemoteSessionStore(path.join(root, "state"));
  const presence = new PresenceTracker();
  const runtime = new TurnRuntime({
    store,
    projects: catalog,
    presence,
    grokBin: "grok",
    spawnAgent: () => {
      throw new Error("不应启动 Worker");
    },
  });
  context.after(async () => {
    await runtime.dispose();
    presence.dispose();
  });

  const pending = await store.createPending("projects/demo");
  pending.clientMessageIds.dup = "existing-turn";
  await store.writeMeta(pending);
  const first = await runtime.sendMessage({
    projectId: "projects/demo",
    sessionId: pending.id,
    text: "hello",
    clientMessageId: "dup",
  });
  assert.equal(first.turnId, "existing-turn");
  assert.equal(first.accepted, true);
});

test("message.user confirms the originating clientMessageId", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "grok-remote-turn-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "demo"), { recursive: true });
  const catalog = await ProjectCatalog.fromRoots([{ id: "projects", path: root }]);
  const store = new RemoteSessionStore(path.join(root, "state"));
  const presence = new PresenceTracker();
  const fake = respondingAgent();
  const runtime = new TurnRuntime({
    store,
    projects: catalog,
    presence,
    grokBin: "grok",
    spawnAgent: () => fake.agent,
  });
  context.after(async () => {
    await runtime.dispose();
    presence.dispose();
  });

  const pending = await store.createPending("projects/demo");
  const events: Array<Record<string, unknown> & { type: string }> = [];
  const completed = new Promise<void>((resolve) => {
    runtime.onEvent((event) => {
      events.push(event);
      if (event.type === "turn.status" && event.status === "completed") resolve();
    });
  });

  await runtime.sendMessage({
    projectId: "projects/demo",
    sessionId: pending.id,
    text: "hello",
    clientMessageId: "client-1",
  });
  await completed;
  await fake.exited;

  const userMessage = events.find((event) => event.type === "message.user");
  assert.ok(userMessage);
  assert.equal(userMessage.clientMessageId, "client-1");
  assert.equal(userMessage.text, "hello");
});

test("command approvals ignore login text and use the concise description", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "grok-remote-turn-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "demo"), { recursive: true });
  const catalog = await ProjectCatalog.fromRoots([{ id: "projects", path: root }]);
  const store = new RemoteSessionStore(path.join(root, "state"));
  const presence = new PresenceTracker();
  const fake = respondingAgent({
    title: "Execute `ssh node1 'echo LAST LOGINS; last -n 15'`",
    kind: "execute",
    rawInput: {
      variant: "Bash",
      command: "ssh node1 'echo LAST LOGINS; last -n 15'",
      description: "Find clone location and recent logins",
    },
    _meta: {
      "x.ai/tool": {
        name: "run_terminal_command",
        kind: "execute",
      },
    },
  });
  const runtime = new TurnRuntime({
    store,
    projects: catalog,
    presence,
    grokBin: "grok",
    spawnAgent: () => fake.agent,
  });
  context.after(async () => {
    await runtime.dispose();
    presence.dispose();
  });

  const pending = await store.createPending("projects/demo");
  let completedResolve: () => void = () => {};
  const completed = new Promise<void>((resolve) => {
    completedResolve = resolve;
  });
  const approvalRequested = new Promise<Record<string, unknown> & { type: string }>((resolve) => {
    runtime.onEvent((event) => {
      if (event.type === "approval.requested") resolve(event);
      if (event.type === "turn.status" && event.status === "completed") completedResolve();
    });
  });

  await runtime.sendMessage({
    projectId: "projects/demo",
    sessionId: pending.id,
    text: "inspect node1",
    clientMessageId: "client-approval",
  });
  const approval = await approvalRequested;
  assert.equal(approval.kind, "command");
  assert.equal(approval.reason, "Find clone location and recent logins");
  assert.doesNotMatch(String(approval.reason), /ssh|LAST LOGINS/);
  assert.equal(typeof approval.approvalId, "string");

  await runtime.answerApproval(String(approval.approvalId), "approve_once", null);
  await completed;
  await fake.exited;
});

function respondingAgent(
  permissionToolCall: Record<string, unknown> | null = null,
): { agent: SpawnedAgent; exited: Promise<void> } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    exitCode: number | null;
    pid: number;
    kill: () => boolean;
  };
  let resolveExited: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const exit = () => {
    if (proc.exitCode !== null) return;
    proc.killed = true;
    proc.exitCode = 0;
    proc.emit("exit", 0, null);
    resolveExited();
  };
  Object.assign(proc, {
    stdin,
    stdout,
    stderr,
    killed: false,
    exitCode: null,
    pid: 1234,
    kill: () => {
      exit();
      return true;
    },
  });

  let buffered = "";
  let promptRequestId: number | null = null;
  stdin.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line) as { id?: number; method?: string };
      if (!request.method) {
        if (request.id === 99 && promptRequestId !== null) {
          stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: promptRequestId,
            result: { stopReason: "end_turn" },
          })}\n`);
          promptRequestId = null;
        }
        continue;
      }
      if (request.id === undefined) continue;
      if (request.method === "session/prompt" && permissionToolCall) {
        promptRequestId = request.id;
        stdout.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "session/request_permission",
          params: {
            sessionId: "grok-session",
            toolCall: permissionToolCall,
            options: [
              { optionId: "allow-once", name: "Yes, proceed", kind: "allow_once" },
              { optionId: "reject-once", name: "No", kind: "reject_once" },
            ],
          },
        })}\n`);
        continue;
      }
      const result = request.method === "initialize"
        ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
        : request.method === "session/new"
        ? { sessionId: "grok-session" }
        : request.method === "session/prompt"
        ? { stopReason: "end_turn" }
        : {};
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    }
  });
  stdin.on("finish", exit);

  const agent: SpawnedAgent = {
    pid: proc.pid,
    process: proc as unknown as ChildProcessWithoutNullStreams,
    killGroup: () => exit(),
  };
  return { agent, exited };
}
