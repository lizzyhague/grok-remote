import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ResolvedAttachment } from "../shared-upload/types.ts";
import {
  buildGrokPrompt,
  MAX_GROK_MESSAGE_ATTACHMENT_BYTES,
  validateGrokAttachments,
} from "./grok-input.ts";

test("maps images, UTF-8 text, and binary files to Grok ACP without exposing paths", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "grok-attachments-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const textBytes = Buffer.from("secret attachment text\n", "utf8");
  const pdfBytes = Buffer.from("%PDF-1.7\nbinary", "utf8");
  const imagePath = path.join(directory, "image.png");
  const textPath = path.join(directory, "notes.txt");
  const pdfPath = path.join(directory, "report.pdf");
  await Promise.all([
    writeFile(imagePath, imageBytes),
    writeFile(textPath, textBytes),
    writeFile(pdfPath, pdfBytes),
  ]);

  const prompt = await buildGrokPrompt("分析这些附件", [
    attachment("image-id", "screen.png", "image/png", "image", imageBytes, imagePath),
    attachment("text-id", "notes.txt", "text/plain", "file", textBytes, textPath),
    attachment("pdf-id", "report.pdf", "application/pdf", "file", pdfBytes, pdfPath),
  ]);

  assert.match(prompt[0]?.type === "text" ? prompt[0].text : "", /screen\.png.*image-id/su);
  assert.deepEqual(prompt[1], {
    type: "image",
    data: imageBytes.toString("base64"),
    mimeType: "image/png",
  });
  assert.deepEqual(prompt[2], {
    type: "resource",
    resource: {
      uri: "file://grok-remote-attachments/text-id.txt",
      mimeType: "text/plain",
      text: "secret attachment text\n",
    },
  });
  assert.deepEqual(prompt[3], {
    type: "resource",
    resource: {
      uri: "file://grok-remote-attachments/pdf-id.pdf",
      mimeType: "application/pdf",
      blob: pdfBytes.toString("base64"),
    },
  });
  assert.equal(JSON.stringify(prompt).includes(directory), false);
});

test("rejects invalid UTF-8 text and oversized aggregate attachment payloads", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "grok-attachments-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const invalid = Buffer.from([0xc3, 0x28]);
  const filePath = path.join(directory, "invalid.txt");
  await writeFile(filePath, invalid);
  await assert.rejects(
    buildGrokPrompt("", [
      attachment("invalid-id", "invalid.txt", "text/plain", "file", invalid, filePath),
    ]),
    /UTF-8/u,
  );

  const tooLarge = attachment(
    "large-id",
    "large.bin",
    "application/octet-stream",
    "file",
    Buffer.alloc(0),
    filePath,
  );
  tooLarge.size = MAX_GROK_MESSAGE_ATTACHMENT_BYTES + 1;
  assert.throws(() => validateGrokAttachments([tooLarge]), /25 MiB/u);
});

function attachment(
  id: string,
  originalName: string,
  detectedMime: string,
  kind: "image" | "file",
  bytes: Buffer,
  filePath: string,
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
    size: bytes.byteLength,
    sha256: "test-sha",
    createdAtMs: 1,
    expiresAtMs: 2,
    path: filePath,
  };
}
