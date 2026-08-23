import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProjectCatalog } from "../projects/catalog.ts";
import { RemoteSessionStore } from "../sessions/store.ts";
import { PresenceTracker } from "../server/presence.ts";
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
