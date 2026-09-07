import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

// Compare actual directory identities, not lowercased strings: macOS can have
// both case-sensitive and case-insensitive volumes. Linux uses this same path.
async function insideRoot(root: string, candidate: string): Promise<boolean> {
  const rootInfo = await stat(root);
  let parent = path.dirname(candidate);
  for (;;) {
    const info = await stat(parent);
    if (info.dev === rootInfo.dev && info.ino === rootInfo.ino) return true;
    const next = path.dirname(parent);
    if (next === parent) return false;
    parent = next;
  }
}

export async function openViewableFile(roots: readonly string[], input: string): Promise<{
  handle: FileHandle;
  size: number;
  contentType: string;
} | null> {
  const contentType = TYPES[path.extname(input).toLowerCase()];
  if (!input || input.includes("\0") || !contentType) return null;
  for (const root of roots) {
    let handle: FileHandle | undefined;
    try {
      const resolved = await realpath(path.resolve(root, input));
      // A whitelisted symlink name must not expose a disallowed target suffix.
      if (TYPES[path.extname(resolved).toLowerCase()] !== contentType ||
          !await insideRoot(root, resolved)) continue;
      handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      const current = await stat(resolved);
      if (!info.isFile() || info.dev !== current.dev || info.ino !== current.ino ||
          !await insideRoot(root, await realpath(resolved))) {
        await handle.close();
        continue;
      }
      return { handle, size: info.size, contentType };
    } catch {
      await handle?.close();
    }
  }
  return null;
}
