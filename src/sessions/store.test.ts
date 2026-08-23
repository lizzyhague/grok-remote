import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RemoteSessionStore } from "./store.ts";

test("deduplicates client message ids and copies events when binding", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "grok-remote-store-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RemoteSessionStore(dir);
  const pending = await store.createPending("projects/demo");
  pending.clientMessageIds["c1"] = "turn-1";
  await store.writeMeta(pending);
  await store.appendEvent(pending.id, { type: "turn.accepted", turnId: "turn-1" });
  const bound = await store.bindGrokSession(pending.id, "grok-session-1");
  assert.equal(bound.id, "grok-session-1");
  assert.equal(bound.clientMessageIds.c1, "turn-1");
  const events = await store.eventsSince("grok-session-1", 0);
  assert.equal(events[0]?.event.type, "turn.accepted");
  assert.equal(await store.readMeta(pending.id), null);
});

test("keeps the grok session id on session.bound events", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "grok-remote-bound-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RemoteSessionStore(dir);
  const pending = await store.createPending("projects/demo");
  const stored = await store.appendEvent(pending.id, {
    sessionId: "grok-session-9",
    type: "session.bound",
    pendingId: pending.id,
  });
  assert.equal(stored.event.sessionId, "grok-session-9");
  assert.equal(stored.event.pendingId, pending.id);
  assert.equal(stored.event.type, "session.bound");
});

test("assigns unique increasing seqs when appends overlap", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "grok-remote-seq-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RemoteSessionStore(dir);
  const pending = await store.createPending("projects/demo");
  const written = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.appendEvent(pending.id, { type: "message.delta", text: String(index) })
    ),
  );
  const seqs = written.map((item) => item.seq).sort((left, right) => left - right);
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_, index) => index + 1));
  const replayed = await store.eventsSince(pending.id, 0);
  assert.deepEqual(replayed.map((item) => item.seq), seqs);
  assert.equal(new Set(replayed.map((item) => item.seq)).size, 20);
});
