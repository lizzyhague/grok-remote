import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openViewableFile } from "./files.ts";

test("file boundary accepts documents and images, rejects traversal and symlink escapes", async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "grok-files-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "root");
  const sibling = path.join(temp, "root-other");
  await mkdir(root);
  await mkdir(sibling);
  await mkdir(path.join(root, "directory.md"));
  await writeFile(path.join(sibling, "outside.md"), "outside");
  await writeFile(path.join(root, ".env"), "private");
  await writeFile(path.join(root, "source.ts"), "code");
  await writeFile(path.join(root, "中文 # ? %.md"), "# 文档");
  await symlink(sibling, path.join(root, "escape"));
  await symlink(path.join(root, ".env"), path.join(root, "secret.md"));
  await symlink(path.join(root, "中文 # ? %.md"), path.join(root, "alias.md"));

  for (const input of [
    "", "missing.md", ".env", "source.ts", "directory.md", "secret.md",
    "../root-other/outside.md", path.join(sibling, "outside.md"),
    "escape/outside.md", "bad\0.md",
  ]) {
    assert.equal(await openViewableFile([root], input), null, input);
  }
  for (const input of ["中文 # ? %.md", "alias.md", path.join(root, "中文 # ? %.md")]) {
    const file = await openViewableFile([root], input);
    assert.ok(file, input);
    try {
      assert.equal(file.contentType, "text/markdown; charset=utf-8");
      assert.equal(await file.handle.readFile("utf8"), "# 文档");
    } finally { await file.handle.close(); }
  }
  for (const suffix of ["svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "PNG"]) {
    await writeFile(path.join(root, `image.${suffix}`), "image");
    const file = await openViewableFile([root], `image.${suffix}`);
    assert.ok(file, suffix);
    assert.match(file.contentType, /^image\//u);
    await file.handle.close();
  }
  assert.equal(await openViewableFile([], path.join(root, "alias.md")), null);
  const secondRoot = await openViewableFile([sibling, root], "alias.md");
  assert.ok(secondRoot);
  await secondRoot.handle.close();
});

test("directory identity respects the filesystem's case behavior", async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "grok-file-case-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "Root");
  await mkdir(root);
  await writeFile(path.join(root, "note.md"), "inside");
  const alternate = path.join(temp, "root");
  let insensitive = false;
  try { insensitive = await realpath(alternate) === await realpath(root); } catch { /* separate path */ }
  if (!insensitive) {
    await mkdir(alternate);
    await writeFile(path.join(alternate, "note.md"), "outside");
  }
  const file = await openViewableFile([root], path.join(alternate, "note.md"));
  if (insensitive) {
    assert.ok(file);
    assert.equal(await file.handle.readFile("utf8"), "inside");
    await file.handle.close();
  } else assert.equal(file, null);
});
