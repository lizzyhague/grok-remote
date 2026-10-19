import type { ResolvedAttachment } from "../shared-upload/types.ts";
import type { AcpPromptContent } from "../worker/acp-client.ts";
import { formatPrivateAttachmentPathsBlock } from "./private-paths.ts";

export class GrokAttachmentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GrokAttachmentError";
    this.code = code;
  }
}

/**
 * The old 25 MiB limit applied to ACP JSON/base64 request bodies. Requests no longer carry file bytes,
 * so the adapter has no aggregate byte limit; shared upload still limits files to 25 MiB and messages to 100 files.
 */
export function validateGrokAttachments(attachments: ResolvedAttachment[]): void {
  const missing = attachments.find((attachment) => !attachment.path);
  if (missing) {
    throw new GrokAttachmentError(
      "attachment_unreadable",
      `Grok Remote could not read the attachment: ${missing.originalName}.`,
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

export function buildGrokPrompt(
  text: string,
  attachments: ResolvedAttachment[],
): AcpPromptContent[] {
  validateGrokAttachments(attachments);
  const prompt: AcpPromptContent[] = [{
    type: "text",
    text: attachmentDisplayText(text, attachments),
  }];
  if (attachments.length === 0) return prompt;
  prompt.push({
    type: "text",
    text: formatPrivateAttachmentPathsBlock(attachments.map((attachment) => ({
      id: attachment.id,
      originalName: attachment.originalName,
      path: attachment.path,
      mimeType: attachment.detectedMime,
      size: attachment.size,
    }))),
  });
  return prompt;
}
