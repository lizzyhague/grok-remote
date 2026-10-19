/**
 * Error text sent to the browser. Messages authored here remain intact, while operating-system
 * errors often contain absolute host paths that must remain only in server logs.
 */
export function publicErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "The request failed.";
  }
  if (isSystemError(error)) {
    console.error(`System error hidden from browser: ${error.message}`);
    return "The server could not access a local file. Check the service log.";
  }
  return redactPaths(error.message);
}

function isSystemError(error: Error): boolean {
  const candidate = error as NodeJS.ErrnoException;
  return typeof candidate.code === "string" && typeof candidate.syscall === "string";
}

function redactPaths(message: string): string {
  return message.replace(/(?:\/[\w.@+-]+){2,}\/?/g, "<path>");
}
