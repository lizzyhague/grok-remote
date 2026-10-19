import assert from "node:assert/strict";
import test from "node:test";

import { publicErrorMessage } from "./public-error.ts";

test("keeps application errors and redacts absolute paths", () => {
  assert.equal(publicErrorMessage(new Error("The project does not exist or is outside the allowed roots.")), "The project does not exist or is outside the allowed roots.");
  assert.equal(
    publicErrorMessage(new Error("无法打开 /home/example-user/private/file")),
    "无法打开 <path>",
  );
});

test("hides operating-system errors", () => {
  const error = Object.assign(new Error("ENOENT: no such file or directory, open '/var/lib/x'"), {
    code: "ENOENT",
    syscall: "open",
  });
  assert.equal(publicErrorMessage(error), "The server could not access a local file. Check the service log.");
});
