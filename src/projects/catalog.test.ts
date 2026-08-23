import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProjectCatalog } from "./catalog.ts";

test("只列出根目录下一层的普通项目文件夹", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "grok-remote-projects-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const root = path.join(temporaryDirectory, "projects");
  const outside = path.join(temporaryDirectory, "outside");
  await mkdir(path.join(root, "alpha"), { recursive: true });
  await mkdir(path.join(root, "nested", "child"), { recursive: true });
  await mkdir(path.join(root, ".hidden"));
  await mkdir(outside);
  await writeFile(path.join(root, "note.txt"), "not a project\n", "utf8");
  await symlink(outside, path.join(root, "escape"), "dir");

  const catalog = await ProjectCatalog.fromRoots([{ id: "workspace", path: root }]);
  const projects = await catalog.list();

  assert.deepEqual(projects, [
    { id: "workspace/alpha", name: "alpha", rootId: "workspace" },
    { id: "workspace/nested", name: "nested", rootId: "workspace" },
  ]);

  const alpha = await catalog.resolve("workspace/alpha");
  assert.equal(alpha.path, path.join(root, "alpha"));

  await assert.rejects(
    catalog.resolve("workspace/..%2Foutside"),
    /不在允许的根目录/u,
  );
});

test("从配置文件读取根目录", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "grok-remote-config-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const root = path.join(temporaryDirectory, "work");
  await mkdir(path.join(root, "demo"), { recursive: true });
  const configPath = path.join(temporaryDirectory, "projects.json");
  await writeFile(configPath, JSON.stringify({
    roots: [{ id: "work", path: root }],
  }));

  const catalog = await ProjectCatalog.fromConfigFile(configPath);
  const projects = await catalog.list();
  assert.deepEqual(projects, [
    { id: "work/demo", name: "demo", rootId: "work" },
  ]);
});
