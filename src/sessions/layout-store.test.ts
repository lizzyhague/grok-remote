import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  resolveLayoutStatePath,
  SessionLayoutStore,
  type TrashEntry,
} from "./layout-store.ts";

async function fixture(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "grok-remote-layout-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "state", "layout.json");
}

function trashEntry(sessionId = "session-1"): TrashEntry {
  return {
    sessionId,
    projectId: "projects/demo",
    deletedAt: 100,
    origin: "active",
  };
}

test("persists archive and trash marks atomically and reloads them", async (context) => {
  const filePath = await fixture(context);
  const store = await SessionLayoutStore.open(filePath);

  await store.archive("session-1", "projects/demo");
  assert.equal(store.isArchived("session-1"), true);
  await store.moveToTrash(trashEntry());
  assert.equal(store.isArchived("session-1"), false);
  assert.deepEqual(store.trashEntry("session-1"), trashEntry());

  const reloaded = await SessionLayoutStore.open(filePath);
  assert.deepEqual(reloaded.listTrash("projects/demo"), [trashEntry()]);
  const file = JSON.parse(await readFile(filePath, "utf8")) as { version: number };
  assert.equal(file.version, 1);

  const restored = await reloaded.restoreTrash("session-1");
  assert.deepEqual(restored, trashEntry());
  assert.equal((await SessionLayoutStore.open(filePath)).isTrashed("session-1"), false);
});

test("restores archived origin back into the archived set", async (context) => {
  const filePath = await fixture(context);
  const store = await SessionLayoutStore.open(filePath);
  await store.archive("session-2", "projects/demo");
  await store.moveToTrash({
    sessionId: "session-2",
    projectId: "projects/demo",
    deletedAt: 200,
    origin: "archived",
  });
  assert.equal(store.isArchived("session-2"), false);
  await store.restoreTrash("session-2");
  assert.equal(store.isArchived("session-2"), true);
  assert.equal(store.isTrashed("session-2"), false);
});

test("rejects malformed state instead of silently discarding it", async (context) => {
  const filePath = await fixture(context);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ version: 1, archived: [{ bad: true }], trash: [] }));
  await assert.rejects(
    () => SessionLayoutStore.open(filePath),
    /格式不正确/u,
  );
});

test("persists pins and reloads files that omit the marked field", async (context) => {
  const filePath = await fixture(context);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({
    version: 1,
    archived: [],
    trash: [],
  }));
  const store = await SessionLayoutStore.open(filePath);
  assert.deepEqual(store.listMarked(), []);
  await store.mark("session-1", "projects/demo");
  assert.equal(store.isMarked("session-1"), true);
  const reloaded = await SessionLayoutStore.open(filePath);
  assert.deepEqual(reloaded.listMarked(), [{
    sessionId: "session-1",
    projectId: "projects/demo",
  }]);
  await reloaded.unmark("session-1");
  assert.equal((await SessionLayoutStore.open(filePath)).isMarked("session-1"), false);
});

test("refuses to pin a session that is already in trash", async (context) => {
  const filePath = await fixture(context);
  const store = await SessionLayoutStore.open(filePath);
  await store.moveToTrash(trashEntry());
  await assert.rejects(() => store.mark("session-1", "projects/demo"), /回收站/u);
});

test("keeps layout.json under the grok-remote state directory", () => {
  assert.equal(resolveLayoutStatePath({
    GROK_REMOTE_STATE_DIR: "/var/lib/grok-remote",
  }), "/var/lib/grok-remote/layout.json");
});
