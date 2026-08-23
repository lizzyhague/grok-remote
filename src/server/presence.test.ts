import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { PresenceTracker } from "./presence.ts";

test("grace period does not fire if a client returns in time", async () => {
  let expired = 0;
  const presence = new PresenceTracker({ graceMs: 40 });
  presence.subscribe({ onGraceExpired: () => {
    expired += 1;
  } });

  presence.add();
  presence.remove();
  await delay(15);
  presence.add();
  await delay(50);
  assert.equal(expired, 0);
  assert.equal(presence.online, true);
  presence.dispose();
});

test("grace period fires after the last client stays gone", async () => {
  let expired = 0;
  const presence = new PresenceTracker({ graceMs: 30 });
  presence.subscribe({ onGraceExpired: () => {
    expired += 1;
  } });

  presence.add();
  presence.add();
  presence.remove();
  assert.equal(presence.online, true);
  presence.remove();
  assert.equal(presence.online, false);
  await delay(50);
  assert.equal(expired, 1);
  presence.dispose();
});
