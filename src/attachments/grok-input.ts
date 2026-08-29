import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ResolvedAttachment } from "../shared-upload/types.ts";
import type { AcpPromptContent } from "../worker/acp-client.ts";

/** Bound the JSON/base64 payload sent over one ACP request. */
export const MAX_GROK_MESSAGE_ATTACHMENT_BYTES = 25 * 1_048_576;

export class GrokAttachmentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GrokAttachmentError";
    this.code = code;
  }
}

export function validateGrokAttachments(attachments: ResolvedAttachment[]): void {
  const total = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (total > MAX_GROK_MESSAGE_ATTACHMENT_BYTES) {
    throw new GrokAttachmentError(
      "attachments_too_large",
      "一条 Grok 消息中的附件合计不能超过 25 MiB。",
    );
  }
}

export function attachmentDisplayText(
  text: string,
  attachments: Pick<ResolvedAttachment, "id" | "originalName">[],
): string {
  const trimmed = text.trim();
  if (attachments.length === 0) return text;
  const lines = attachments.map((attachment) =>
    `[附件：${attachment.originalName} · ${attachment.id}]`);
  return trimmed ? `${text}\n\n${lines.join("\n")}` : lines.join("\n");
}

export async function buildGrokPrompt(
  text: string,
  attachments: ResolvedAttachment[],
): Promise<AcpPromptContent[]> {
  validateGrokAttachments(attachments);
  const prompt: AcpPromptContent[] = [{
    type: "text",
    text: attachmentDisplayText(text, attachments),
  }];
  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (const attachment of attachments) {
    let bytes: Buffer;
    try {
      bytes = await readFile(attachment.path);
    } catch {
      throw new GrokAttachmentError(
        "attachment_unreadable",
        `Grok Remote 无法读取附件：${attachment.originalName}。`,
      );
    }
    if (bytes.byteLength !== attachment.size) {
      throw new GrokAttachmentError(
        "attachment_size_changed",
        `附件大小在上传后发生了变化：${attachment.originalName}。`,
      );
    }
    if (attachment.kind === "image") {
      prompt.push({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: attachment.detectedMime,
      });
      continue;
    }

    const uri = attachmentResourceUri(attachment);
    if (isTextAttachment(attachment)) {
      let content: string;
      try {
        content = decoder.decode(bytes);
      } catch {
        throw new GrokAttachmentError(
          "attachment_invalid_utf8",
          `Grok 无法读取不是有效 UTF-8 的文本附件：${attachment.originalName}。`,
        );
      }
      prompt.push({
        type: "resource",
        resource: { uri, mimeType: attachment.detectedMime, text: content },
      });
    } else {
      prompt.push({
        type: "resource",
        resource: {
          uri,
          mimeType: attachment.detectedMime,
          blob: bytes.toString("base64"),
        },
      });
    }
  }
  return prompt;
}

function isTextAttachment(attachment: ResolvedAttachment): boolean {
  const mime = attachment.detectedMime;
  return mime.startsWith("text/") || mime === "application/json" ||
    mime.endsWith("+json") || mime === "application/xml" || mime.endsWith("+xml") ||
    mime === "application/javascript" || mime === "application/markdown";
}

function attachmentResourceUri(attachment: ResolvedAttachment): string {
  const extension = path.extname(attachment.originalName).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,10}$/u.test(extension) ? extension : "";
  return `file://grok-remote-attachments/${attachment.id}${safeExtension}`;
}
