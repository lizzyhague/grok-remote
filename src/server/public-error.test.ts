import assert from "node:assert/strict";
import test from "node:test";

import { publicErrorMessage } from "./public-error.ts";

test("keeps application errors and redacts absolute paths", () => {
  assert.equal(publicErrorMessage(new Error("项目不存在，或不在允许的根目录中。")), "项目不存在，或不在允许的根目录中。");
  assert.equal(
    publicErrorMessage(new Error("无法打开 /home/example-user/private/file")),
    "无法打开 <路径>",
  );
});

test("hides operating-system errors", () => {
  const error = Object.assign(new Error("ENOENT: no such file or directory, open '/var/lib/x'"), {
    code: "ENOENT",
    syscall: "open",
  });
  assert.equal(publicErrorMessage(error), "服务器无法访问本地文件，请查看服务日志。");
});
