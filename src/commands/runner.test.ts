import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GrokSessionDisk } from "../sessions/disk.ts";
import { RemoteSessionStore } from "../sessions/store.ts";
import { CommandRunner } from "./runner.ts";

test("keeps context and session-info as distinct native queries", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "grok-remote-commands-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new RemoteSessionStore(path.join(root, "state"));
  await store.writeMeta({
    id: "s1",
    projectId: "p1",
    grokSessionId: "s1",
    permissionMode: "ask",
    title: "Demo",
    createdAt: 1,
    clientMessageIds: {},
  });
  const runtime = fakeRuntime();
  const runner = new CommandRunner(runtime, new GrokSessionDisk(root), store);

  const contextResult = await runner.run("s1", "context", null, null) as {
    title: string;
    lines: string[];
  };
  assert.equal(contextResult.title, "上下文");
  assert.match(contextResult.lines.join("\n"), /工具定义：8,448 tokens（25 个）/);

  const statusResult = await runner.run("s1", "session-info", null, null) as {
    title: string;
    lines: string[];
  };
  assert.equal(statusResult.title, "会话状态");
  assert.match(statusResult.lines.join("\n"), /权限：ask/);
  assert.match(statusResult.lines.join("\n"), /API：Responses/);
});

test("parses a typed model and effort without sending a slash prompt", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "grok-remote-commands-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const selected: Array<{ model: string; effort: string | null }> = [];
  const runtime = {
    ...fakeRuntime(),
    async setModel(_sessionId: string, modelId: string, effort: string | null) {
      selected.push({ model: modelId, effort });
      return { sessionId: "s1", modelId, reasoningEffort: effort };
    },
  };
  const runner = new CommandRunner(
    runtime,
    new GrokSessionDisk(root),
    new RemoteSessionStore(path.join(root, "state")),
  );

  await runner.run("s1", "model", "grok-4.5 medium", null);
  assert.deepEqual(selected, [{ model: "grok-4.5", effort: "medium" }]);
});

function fakeRuntime() {
  return {
    async toggleAlwaysApprove() {
      return { enabled: false };
    },
    cachedModels() {
      return [];
    },
    async inspectSession() {
      return {
        sessionId: "s1",
        model: "grok-4.5",
        modelDisplayName: "Grok 4.5",
        apiBackend: "Responses",
        context: {
          used: 4_316,
          total: 500_000,
          freeTokens: 495_684,
          systemPromptTokens: 1_516,
          messageTokens: 2_800,
          messageCount: 3,
          toolDefinitionsTokens: 8_448,
          toolDefinitionsCount: 25,
          turnCount: 1,
          toolCallCount: 0,
          compactionCount: 0,
          usagePct: 1,
        },
      };
    },
    async setModel(_sessionId: string, modelId: string, reasoningEffort: string | null) {
      return { sessionId: "s1", modelId, reasoningEffort };
    },
    async setEffort(_sessionId: string, reasoningEffort: string) {
      return { sessionId: "s1", modelId: "grok-4.5", reasoningEffort };
    },
    async enterPlan() {
      return { sessionId: "s1" };
    },
    async renameSession(_sessionId: string, title: string) {
      return { sessionId: "s1", title };
    },
    async compact() {
      return { turnId: "compact-turn" };
    },
    async rewind() {
      return { kind: "rewind" as const, sessionId: "s1", promptText: null };
    },
  };
}
