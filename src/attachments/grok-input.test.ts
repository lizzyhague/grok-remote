import assert from "node:assert/strict";
import test from "node:test";

import type { ResolvedAttachment } from "../shared-upload/types.ts";
import { buildGrokPrompt, validateGrokAttachments } from "./grok-input.ts";
import { stripPrivateAttachmentPaths } from "./private-paths.ts";

test("sends a path block for images, PDFs, text, zip and invalid UTF-8", () => {
  const imagePath = "/not-read/screen.png";
  const pdfPath = "/not-read/report.pdf";
  const textPath = "/not-read/notes.txt";
  const zipPath = "/not-read/archive.zip";
  const brokenPath = "/not-read/broken.bin";

  const prompt = buildGrokPrompt("分析这些附件", [
    attachment("image-id", "screen.png", "image/png", "image", imagePath, 4),
    attachment("pdf-id", "report.pdf", "application/pdf", "file", pdfPath, 8),
    attachment("text-id", "notes.txt", "text/plain", "file", textPath, 15),
    attachment("zip-id", "archive.zip", "application/octet-stream", "file", zipPath, 2),
    attachment("bin-id", "broken.bin", "application/octet-stream", "file", brokenPath, 2),
  ]);

  assert.equal(prompt.length, 2);
  assert.equal(prompt[0]?.type, "text");
  assert.match(prompt[0]?.type === "text" ? prompt[0].text : "", /screen\.png.*image-id/su);
  assert.equal(prompt[1]?.type, "text");
  const block = prompt[1]?.type === "text" ? prompt[1].text : "";
  assert.match(block, /\[AI_REMOTE_PRIVATE_ATTACHMENT_PATHS_V1\]/u);
  assert.ok(block.includes(imagePath));
  assert.ok(block.includes(zipPath));
  assert.equal(block.includes("secret attachment text"), false);
  assert.equal(block.includes("iVBORw"), false);
  assert.equal(prompt.some((entry) => entry.type === "image" || entry.type === "resource"), false);
});

test("keeps display text empty for attachment-only messages and still sends the path block", () => {
  const prompt = buildGrokPrompt("", [
    attachment("zip-id", "archive.zip", "application/octet-stream", "file", "/not-read/archive.zip", 2),
  ]);
  assert.equal(prompt.length, 2);
  assert.match(prompt[0]?.type === "text" ? prompt[0].text : "", /archive\.zip/u);
  const block = prompt[1]?.type === "text" ? prompt[1].text : "";
  assert.ok(block.includes("/not-read/archive.zip"));
  assert.equal(stripPrivateAttachmentPaths(block), "");
});

test("serializes names with quotes, newlines and Chinese", () => {
  const prompt = buildGrokPrompt("看这个", [
    attachment(
      "id-1",
      "报\"告\n.pdf",
      "application/pdf",
      "file",
      "/uploads/blobs/ab/id-1.pdf",
      12,
    ),
  ]);
  const block = prompt[1]?.type === "text" ? prompt[1].text : "";
  const jsonLine = block.split("\n").find((line) => line.startsWith("{\"attachments\":")) ?? "";
  const parsed = JSON.parse(jsonLine) as { attachments: Array<{ originalName: string }> };
  assert.equal(parsed.attachments[0]?.originalName, "报\"告\n.pdf");
});

test("rejects attachments that have no storage path", () => {
  assert.throws(
    () => validateGrokAttachments([
      attachment("id-1", "missing.bin", "application/octet-stream", "file", "", 1),
    ]),
    (error: unknown) => error instanceof Error &&
      "code" in error &&
      error.code === "attachment_unreadable" &&
      !error.message.includes("/"),
  );
});

function attachment(
  id: string,
  originalName: string,
  detectedMime: string,
  kind: "image" | "file",
  filePath: string,
  size: number,
): ResolvedAttachment {
  return {
    id,
    caller: "grok",
    projectId: "projects/demo",
    sessionId: "session-1",
    originalName,
    declaredMime: detectedMime,
    detectedMime,
    kind,
    size,
    sha256: "test-sha",
    createdAtMs: 1,
    expiresAtMs: 2,
    path: filePath,
  };
}
