import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { MemoryReading } from "../platform/system-resources.ts";
import { ProjectCatalog } from "../projects/catalog.ts";
import { RemoteSessionStore } from "../sessions/store.ts";
import { PresenceTracker } from "../server/presence.ts";
import { ProjectTaskLocks } from "../server/project-locks.ts";
import { AttachmentDisplayIndex } from "../sessions/attachment-index.ts";
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
    availableMemory: ampleMemory,
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
    attachmentIds: [],
  });
  assert.equal(first.turnId, "existing-turn");
  assert.equal(first.accepted, true);
});

test("rejects a session that belongs to a different project before leasing attachments", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "grok-remote-turn-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "one"), { recursive: true });
  await mkdir(path.join(root, "two"), { recursive: true });
  const catalog = await ProjectCatalog.fromRoots([{ id: "projects", path: root }]);
  const store = new RemoteSessionStore(path.join(root, "state"));
  const presence = new PresenceTracker();
  let leaseCalls = 0;
  const runtime = new TurnRuntime({
    store,
    projects: catalog,
    presence,
    grokBin: "grok",
    availableMemory: ampleMemory,
    spawnAgent: () => {
      throw new Error("不应启动 Worker");
    },
    uploads: {
      async createLease() {
        leaseCalls += 1;
        throw new Error("不应创建租约");
      },
      async renewLease(leaseId) {
        return { leaseId, expiresAtMs: Date.now() + 60_000 };
      },
      async releaseLease() {},
    },
  });
  context.after(async () => {
    await runtime.dispose();
    presence.dispose();
  });

  const pending = await store.createPending("projects/one");
  await assert.rejects(
    runtime.sendMessage({
      projectId: "projects/two",
      sessionId: pending.id,
      text: "hello",
      clientMessageId: "wrong-project",
      attachmentIds: ["attachment-id"],
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "session_project_mismatch",
  );
  assert.equal(leaseCalls, 0);
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
    availableMemory: ampleMemory,
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
    attachmentIds: [],
  });
  await completed;
  await fake.exited;

  const userMessage = events.find((event) => event.type === "message.user");
  assert.ok(userMessage);
  assert.equal(userMessage.clientMessageId, "client-1");
  assert.equal(userMessage.text, "hello");
});

test("leases attachments, sends private content to ACP, and releases without persisting paths", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "grok-remote-turn-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "demo"), { recursive: true });
  const privatePath = path.join(root, "shared-private-note.txt");
  await writeFile(privatePath, "private attachment body\n", "utf8");
  const catalog = await ProjectCatalog.fromRoots([{ id: "projects", path: root }]);
  const store = new RemoteSessionStore(path.join(root, "state"));
  const attachmentIndex = await AttachmentDisplayIndex.open(path.join(root, "state"));
  const presence = new PresenceTracker();
  const fake = respondingAgent(null, [
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `读了 ${privatePath}` },
    },
  ]);
  let binding: unknown;
  let released = 0;
  const runtime = new TurnRuntime({
    store,
    projects: catalog,
    presence,
    grokBin: "grok",
    availableMemory: ampleMemory,
    spawnAgent: () => fake.agent,
    attachmentIndex,
    uploads: {
      async createLease(receivedBinding, ownerId, attachmentIds) {
        binding = { receivedBinding, ownerId, attachmentIds };
        return {
          leaseId: "lease-1",
          ownerId,
          expiresAtMs: Date.now() + 60_000,
          attachments: [{
            id: attachmentIds[0]!,
            caller: "grok",
            projectId: "projects/demo",
            sessionId: "pending-binding",
            originalName: "private-note.txt",
            declaredMime: "text/plain",
            detectedMime: "text/plain",
            kind: "file",
            size: Buffer.byteLength("private attachment body\n"),
            sha256: "test-sha",
            createdAtMs: 1,
            expiresAtMs: 2,
            path: privatePath,
          }],
        };
      },
      async renewLease(leaseId) {
        return { leaseId, expiresAtMs: Date.now() + 60_000 };
      },
      async releaseLease(leaseId, ownerId) {
        assert.equal(leaseId, "lease-1");
        assert.equal(typeof ownerId, "string");
        released += 1;
      },
    },
  });
  context.after(async () => {
    await runtime.dispose();
    presence.dispose();
  });

  const pending = await store.createPending("projects/demo");
  const completed = new Promise<void>((resolve) => {
    runtime.onEvent((event) => {
      if (event.type === "turn.status" && event.status === "completed") resolve();
    });
  });
  await runtime.sendMessage({
    projectId: "projects/demo",
    sessionId: pending.id,
    text: "summarize",
    clientMessageId: "client-attachment",
    attachmentIds: ["attachment-id"],
  });
  await completed;
  await fake.exited;

  assert.deepEqual(
    (binding as { receivedBinding: unknown }).receivedBinding,
    { caller: "grok", projectId: "projects/demo", sessionId: pending.id },
  );
  const prompt = (fake.prompts[0] as { prompt: Array<{ type?: string }> }).prompt;
  assert.equal(JSON.stringify(prompt).includes("private attachment body"), false);
  assert.equal(JSON.stringify(prompt).includes(privatePath), true);
  assert.match(JSON.stringify(prompt), /\[AI_REMOTE_PRIVATE_ATTACHMENT_PATHS_V1\]/u);
  assert.equal(prompt.some((entry) => entry.type === "image" || entry.type === "resource"), false);
  assert.equal(released, 1);
  const stored = await store.eventsSince("grok-session", 0);
  const publicEvents = JSON.stringify(stored);
  assert.equal(publicEvents.includes(privatePath), false);
  assert.equal(publicEvents.includes("private attachment body"), false);
  assert.match(publicEvents, /private-note\.txt/u);
  assert.match(publicEvents, /附件：private-note\.txt/u);
  assert.deepEqual(
    (await attachmentIndex.mappingsFor("grok-session")).map((entry) => entry.path),
    [privatePath],
  );
});

test("command approvals ignore login text and use the concise description", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "grok-remote-turn-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "demo"), { recursive: true });
  const catalog = await ProjectCatalog.fromRoots([{ id: "projects", path: root }]);
  const store = new RemoteSessionStore(path.join(root, "state"));
  const presence = new PresenceTracker();
  const fake = respondingAgent({
    title: "Execute `ssh example-host 'echo LAST LOGINS; last -n 15'`",
    kind: "execute",
    rawInput: {
      variant: "Bash",
      command: "ssh example-host 'echo LAST LOGINS; last -n 15'",
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
    availableMemory: ampleMemory,
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
    text: "inspect example-host",
    clientMessageId: "client-approval",
    attachmentIds: [],
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

for (const phase of ["session/new", "session/resume", "session/prompt"]) {
  test(`stopping during ${phase} prevents later work and holds the project until cleanup`, { timeout: 5_000 }, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "grok-remote-stop-"));
    const store = new RemoteSessionStore(path.join(root, "state"));
    let meta = await store.createPending("projects/demo");
    if (phase !== "session/new") meta = await store.bindGrokSession(meta.id, "grok-session");
    const fake = respondingAgent(null, [], [phase, "session/close"]);
    const presence = new PresenceTracker();
    const runtime = new TurnRuntime({
      store,
      projects: { resolve: async () => ({ id: "projects/demo", name: "demo", rootId: "projects", path: root }) },
      presence,
      grokBin: "fake",
      availableMemory: ampleMemory,
      spawnAgent: () => fake.agent,
    });
    const locks = new ProjectTaskLocks(runtime);
    context.after(async () => {
      fake.agent.killGroup("SIGTERM");
      locks.dispose();
      await runtime.dispose();
      presence.dispose();
      await rm(root, { recursive: true, force: true });
    });
    locks.acquire("projects/demo", "page-b", meta.id);
    const statuses: string[] = [];
    const finished = new Promise<void>((resolve) => runtime.onEvent((event) => {
      if (event.type !== "turn.status") return;
      statuses.push(String(event.status));
      if (event.status === "interrupted") resolve();
    }));
    const input = {
      projectId: "projects/demo", sessionId: meta.id, text: "explain a project",
      clientMessageId: "first", attachmentIds: [],
    };
    await runtime.sendMessage(input);
    locks.release("projects/demo", "page-b");
    await fake.waitForRequest(phase);
    await runtime.stop(meta.id);
    assert.deepEqual(statuses, ["running"]);
    assert.equal(runtime.isBusy(meta.id), true);
    assert.equal(locks.acquire("projects/demo", "page-a", "a"), false);
    const duplicate = await runtime.sendMessage(input);
    assert.equal(duplicate.accepted, true);
    await assert.rejects(runtime.sendMessage({ ...input, clientMessageId: "second" }), /正在结束任务/u);
    fake.reply(phase, phase === "session/new" ? { sessionId: "grok-session" } : { stopReason: "end_turn" });
    await fake.waitForRequest("session/close");
    assert.deepEqual(statuses, ["running"]);
    assert.equal(locks.acquire("projects/demo", "page-a", "a"), false);
    assert.equal(fake.prompts.length, phase === "session/prompt" ? 1 : 0);
    fake.reply("session/close");
    await finished;
    assert.deepEqual(statuses, ["running", "interrupted"]);
    assert.equal(runtime.isBusy("grok-session"), false);
    assert.equal(fake.agent.process.exitCode, 0);
    assert.equal(locks.acquire("projects/demo", "page-a", "a"), true);
  });
}

for (const stop of [false, true]) {
  test(`a message being persisted survives the previous turn ending (stop=${stop})`, { timeout: 5_000 }, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "grok-remote-handoff-"));
    const store = new RemoteSessionStore(path.join(root, "state"));
    const pending = await store.createPending("projects/demo");
    const meta = await store.bindGrokSession(pending.id, "grok-session");
    const fake = respondingAgent(null, [], ["session/prompt"]);
    const presence = new PresenceTracker();
    const runtime = new TurnRuntime({
      store,
      projects: { resolve: async () => ({ id: "projects/demo", name: "demo", rootId: "projects", path: root }) },
      presence, grokBin: "fake", availableMemory: ampleMemory,
      spawnAgent: () => fake.agent,
    });
    const allowWrite = Promise.withResolvers<void>();
    const writeStarted = Promise.withResolvers<void>();
    context.after(async () => {
      allowWrite.resolve();
      fake.agent.killGroup("SIGTERM");
      await runtime.dispose();
      presence.dispose();
      await rm(root, { recursive: true, force: true });
    });
    const statuses: string[] = [];
    const firstDone = Promise.withResolvers<void>();
    const secondDone = Promise.withResolvers<void>();
    runtime.onEvent((event) => {
      if (event.type !== "turn.status" || !["completed", "interrupted", "failed"].includes(String(event.status))) return;
      statuses.push(String(event.status));
      if (statuses.length === 1) firstDone.resolve();
      else secondDone.resolve();
    });
    const input = { projectId: "projects/demo", sessionId: meta.id, text: "first", clientMessageId: "first", attachmentIds: [] };
    await runtime.sendMessage(input);
    await fake.waitForRequest("session/prompt");
    const writeMeta = store.writeMeta.bind(store);
    store.writeMeta = async (value) => {
      if (value.clientMessageIds.second) {
        writeStarted.resolve();
        await allowWrite.promise;
      }
      await writeMeta(value);
    };
    const second = runtime.sendMessage({ ...input, text: "second", clientMessageId: "second" });
    await writeStarted.promise;
    if (stop) await runtime.stop(meta.id);
    fake.reply("session/prompt", { stopReason: "end_turn" });
    await firstDone.promise;
    assert.equal(fake.methods.includes("session/close"), false);
    assert.equal(runtime.isBusy(meta.id), true);
    allowWrite.resolve();
    await second;
    if (!stop) {
      await fake.waitForRequest("session/prompt", 2);
      fake.reply("session/prompt", { stopReason: "end_turn" });
    }
    await secondDone.promise;
    assert.deepEqual(statuses, stop ? ["interrupted", "interrupted"] : ["completed", "completed"]);
    assert.equal(fake.prompts.length, stop ? 1 : 2);
    assert.equal(runtime.isBusy(meta.id), false);
  });
}

function respondingAgent(
  permissionToolCall: Record<string, unknown> | null = null,
  updates: Array<Record<string, unknown>> = [],
  heldMethods: string[] = [],
) {
  const requests = new EventEmitter();
  const methods: string[] = [];
  const held = new Map<string, number[]>();
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
  const prompts: unknown[] = [];
  stdin.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
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
      methods.push(request.method);
      requests.emit(request.method);
      if (request.id === undefined) continue;
      if (request.method === "session/prompt") prompts.push(request.params);
      if (heldMethods.includes(request.method)) {
        const ids = held.get(request.method) ?? [];
        ids.push(request.id);
        held.set(request.method, ids);
        continue;
      }
      if (request.method === "session/prompt") {
        for (const update of updates) {
          stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "grok-session", update },
          })}\n`);
        }
      }
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
  return {
    agent, exited, prompts, methods,
    async waitForRequest(method: string, count = 1) {
      while (methods.filter((called) => called === method).length < count) await once(requests, method);
    },
    reply(method: string, result: unknown = {}) {
      const id = held.get(method)?.shift();
      assert.notEqual(id, undefined, `No pending ${method}`);
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    },
  };
}

async function ampleMemory(): Promise<MemoryReading> {
  return {
    availableBytes: 8 * 1_024 * 1_048_576,
    platform: "linux",
    source: "linux-meminfo",
  };
}
