import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ProjectCatalog } from "../projects/catalog.ts";
import { GrokSessionDisk } from "./disk.ts";
import { SessionLayoutStore } from "./layout-store.ts";
import { SessionService, TRASH_RETENTION_SECONDS } from "./service.ts";
import { RemoteSessionStore } from "./store.ts";

async function createFixture(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "grok-remote-service-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, "projects", "alpha");
  await mkdir(projectPath, { recursive: true });
  const catalog = await ProjectCatalog.fromRoots([{
    id: "workspace",
    path: path.join(root, "projects"),
  }]);
  const grokHome = path.join(root, "grok-home");
  const group = path.join(grokHome, "sessions", encodeURIComponent(projectPath));
  await mkdir(path.join(group, "session-keep"), { recursive: true });
  await writeSummary(path.join(group, "session-keep"), "session-keep", projectPath, "Keep me");
  const layout = await SessionLayoutStore.open(path.join(root, "layout.json"));
  const store = new RemoteSessionStore(path.join(root, "state"));
  return {
    catalog,
    disk: new GrokSessionDisk(grokHome),
    store,
    layout,
    projectId: "workspace/alpha",
    projectPath,
    grokHome,
    group,
  };
}

async function writeSummary(
  directory: string,
  id: string,
  cwd: string,
  title: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "summary.json"), JSON.stringify({
    info: { id, cwd },
    generated_title: title,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    last_active_at: "2026-01-02T00:00:00.000Z",
  }));
}

test("lists disk sessions and keeps pending sessions off the list", async (context) => {
  const { catalog, disk, store, layout, projectId } = await createFixture(context);
  const service = new SessionService(catalog, disk, store, layout);
  await service.start(projectId);
  const page = await service.list(projectId);
  assert.deepEqual(page.sessions.map((session) => session.id), ["session-keep"]);
  assert.equal(page.sessions[0]?.pending, false);
});

test("archives a session, hides it from active, and restores it", async (context) => {
  const { catalog, disk, store, layout, projectId } = await createFixture(context);
  const service = new SessionService(catalog, disk, store, layout);

  assert.deepEqual(await service.archive(projectId, ["session-keep"]), {
    succeeded: ["session-keep"],
    failed: [],
  });
  assert.deepEqual((await service.list(projectId)).sessions, []);
  assert.equal((await service.list(projectId, { view: "archived" })).sessions[0]?.id, "session-keep");

  assert.deepEqual(await service.unarchive(projectId, ["session-keep"]), {
    succeeded: ["session-keep"],
    failed: [],
  });
  assert.equal((await service.list(projectId)).sessions[0]?.id, "session-keep");
  assert.deepEqual((await service.list(projectId, { view: "archived" })).sessions, []);
});

test("moves an active session to trash and restores it to the active list", async (context) => {
  const { catalog, disk, store, layout, projectId } = await createFixture(context);
  const now = 1_000;
  const service = new SessionService(catalog, disk, store, layout, { now: () => now });

  const removed = await service.moveToTrash(projectId, ["session-keep"], "active");
  assert.deepEqual(removed, { succeeded: ["session-keep"], failed: [] });
  assert.deepEqual((await service.list(projectId)).sessions, []);
  const trash = await service.list(projectId, { view: "trash" });
  assert.equal(trash.sessions[0]?.id, "session-keep");
  assert.equal(trash.sessions[0]?.deletedAt, now);
  assert.equal(trash.sessions[0]?.purgeAt, now + TRASH_RETENTION_SECONDS);

  await assert.rejects(
    () => service.open(projectId, "session-keep"),
    /回收站/u,
  );

  assert.deepEqual(await service.restoreTrash(projectId, ["session-keep"]), {
    succeeded: ["session-keep"],
    failed: [],
  });
  assert.equal((await service.list(projectId)).sessions[0]?.id, "session-keep");
  assert.deepEqual((await service.list(projectId, { view: "trash" })).sessions, []);
});

test("restores a trashed archived session back to archived", async (context) => {
  const { catalog, disk, store, layout, projectId } = await createFixture(context);
  const service = new SessionService(catalog, disk, store, layout);
  await service.archive(projectId, ["session-keep"]);
  await service.moveToTrash(projectId, ["session-keep"], "archived");
  assert.deepEqual((await service.list(projectId, { view: "archived" })).sessions, []);
  await service.restoreTrash(projectId, ["session-keep"]);
  assert.equal((await service.list(projectId, { view: "archived" })).sessions[0]?.id, "session-keep");
});

test("permanently deletes trash entries after thirty days", async (context) => {
  const { catalog, disk, store, layout, projectId, group, projectPath } = await createFixture(context);
  await writeSummary(path.join(group, "session-old"), "session-old", projectPath, "Old");
  await layout.moveToTrash({
    sessionId: "session-old",
    projectId,
    deletedAt: 100,
    origin: "active",
  });
  const service = new SessionService(catalog, disk, store, layout, {
    now: () => 100 + TRASH_RETENTION_SECONDS,
  });
  assert.deepEqual(await service.purgeExpired(), { deleted: 1, failed: [] });
  assert.equal(layout.isTrashed("session-old"), false);
  assert.equal(await disk.read("session-old"), null);
});

test("does not archive a session while its task is active", async (context) => {
  const { catalog, disk, store, layout, projectId } = await createFixture(context);
  const service = new SessionService(catalog, disk, store, layout, {
    isRunning: (sessionId) => sessionId === "session-keep",
  });
  const result = await service.archive(projectId, ["session-keep"]);
  assert.equal(result.succeeded.length, 0);
  assert.match(result.failed[0]?.message ?? "", /仍有任务正在运行/u);
});

test("refuses to mutate a pending session", async (context) => {
  const { catalog, disk, store, layout, projectId } = await createFixture(context);
  const service = new SessionService(catalog, disk, store, layout);
  const opened = await service.start(projectId);
  const result = await service.moveToTrash(projectId, [opened.session.id], "active");
  assert.equal(result.succeeded.length, 0);
  assert.match(result.failed[0]?.message ?? "", /还没有保存/u);
});
