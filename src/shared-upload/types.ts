export const MAX_UPLOAD_BYTES = 25 * 1_048_576;

export type AttachmentBinding = {
  caller: "grok";
  projectId: string;
  sessionId: string;
};

export type PublicAttachment = AttachmentBinding & {
  id: string;
  originalName: string;
  declaredMime: string;
  detectedMime: string;
  kind: "image" | "file";
  size: number;
  sha256: string;
  createdAtMs: number;
  expiresAtMs: number;
};

/** Only the local Grok adapter receives this shape. Never serialize it to a browser. */
export type ResolvedAttachment = PublicAttachment & {
  path: string;
};

export type UploadTicket = {
  ticket: string;
  expiresAtMs: number;
  attachment: Pick<
    PublicAttachment,
    "caller" | "projectId" | "sessionId" | "originalName" | "declaredMime"
  > & { expectedSize: number };
};

export type AttachmentLease = {
  leaseId: string;
  ownerId: string;
  expiresAtMs: number;
  attachments: ResolvedAttachment[];
};

export class SharedUploadError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "SharedUploadError";
    this.code = code;
    this.status = status;
  }
}
