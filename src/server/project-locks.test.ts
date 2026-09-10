import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import type { BrowserTurnEvent } from "../turns/runtime.ts";
import { ProjectTaskLocks } from "./project-locks.ts";

function setup() {
  const events = new EventEmitter();
  const locks = new ProjectTaskLocks({
    onEvent(listener) {
      events.on("event", listener);
      return () => { events.off("event", listener); };
    },
  });
  return { locks, emit: (event: BrowserTurnEvent) => events.emit("event", event) };
}

test("reserves one session per project, including requests from the same page", () => {
  const { locks } = setup();
  assert.equal(locks.acquire("project", "page-b", "b"), true);
  assert.equal(locks.acquire("project", "page-a", "a"), false);
  assert.equal(locks.acquire("project", "page-b", "a"), false);
  assert.equal(locks.acquire("project", "page-b", "b"), true);
  assert.equal(locks.release("project", "page-a"), false);
  assert.equal(locks.release("project", "page-b"), true);
  assert.equal(locks.acquire("project", "page-a", "a"), true);
});

test("an accepted task survives request failures and disconnects until its own final event", () => {
  const { locks, emit } = setup();
  locks.acquire("project", "page-b", "b");
  emit({ type: "turn.accepted", sessionId: "b", turnId: "b-turn" });
  assert.equal(locks.release("project", "page-b"), false);
  locks.disconnect("page-b");
  assert.equal(locks.acquire("project", "page-a", "a"), false);
  emit({ type: "turn.status", sessionId: "b", turnId: "older-turn", status: "completed" });
  assert.equal(locks.acquire("project", "page-a", "a"), false);
  emit({ type: "turn.status", sessionId: "a", turnId: "b-turn", status: "completed" });
  assert.equal(locks.acquire("project", "page-a", "a"), false);
  emit({ type: "turn.status", sessionId: "b", turnId: "b-turn", status: "interrupted" });
  assert.equal(locks.acquire("project", "page-a", "a"), true);
});

test("binding a new session preserves the lock and lets its reconnected page reclaim control", () => {
  const { locks, emit } = setup();
  locks.acquire("project", "page-b", "pending-b");
  emit({ type: "turn.accepted", sessionId: "pending-b", turnId: "b-turn" });
  locks.release("project", "page-b");
  emit({ type: "session.bound", sessionId: "b", pendingId: "pending-b" });
  locks.disconnect("page-b");
  locks.reclaim("project", "page-a", "a");
  assert.equal(locks.owns("project", "page-a"), false);
  locks.reclaim("project", "reconnected-b", "b");
  assert.equal(locks.owns("project", "reconnected-b", "b"), true);
  assert.equal(locks.owns("project", "reconnected-b", "a"), false);
  emit({ type: "turn.status", sessionId: "b", turnId: "b-turn", status: "completed" });
  assert.equal(locks.acquire("project", "page-a", "a"), true);
});

test("all accepted turns must finish before another session can acquire the project", () => {
  const { locks, emit } = setup();
  locks.acquire("project", "page-b", "b");
  for (const turnId of ["first", "second"]) emit({ type: "turn.accepted", sessionId: "b", turnId });
  locks.release("project", "page-b");
  emit({ type: "turn.status", sessionId: "b", turnId: "first", status: "interrupted" });
  assert.equal(locks.acquire("project", "page-a", "a"), false);
  emit({ type: "turn.status", sessionId: "b", turnId: "second", status: "interrupted" });
  assert.equal(locks.acquire("project", "page-a", "a"), true);
});

test("a final event cannot release a reservation for the next request", () => {
  const { locks, emit } = setup();
  locks.acquire("project", "page-b", "b");
  emit({ type: "turn.accepted", sessionId: "b", turnId: "first" });
  locks.release("project", "page-b");
  locks.acquire("project", "page-b", "b");
  emit({ type: "turn.status", sessionId: "b", turnId: "first", status: "completed" });
  assert.equal(locks.acquire("project", "page-a", "a"), false);
  emit({ type: "turn.accepted", sessionId: "b", turnId: "second" });
  locks.release("project", "page-b");
  assert.equal(locks.acquire("project", "page-a", "a"), false);
  emit({ type: "turn.status", sessionId: "b", turnId: "second", status: "completed" });
  assert.equal(locks.acquire("project", "page-a", "a"), true);
});
