/** Outcome of inspecting a server "listen" error: a port conflict vs anything else. */
export type ListenErrorVerdict =
  | { kind: "port-in-use"; message: string }
  | { kind: "other"; message: string };

function readErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Classify a Node server "listen" error. EADDRINUSE means another process holds the port — the
 * caller should log and exit non-zero so the OS scheduler restarts it (self-healing). Any other
 * error is surfaced verbatim for diagnosis.
 */
export function classifyListenError(error: unknown, port: number): ListenErrorVerdict {
  if (readErrorCode(error) === "EADDRINUSE") {
    return {
      kind: "port-in-use",
      message: `Port ${port} is already in use; the dashboard could not start. It will retry.`,
    };
  }
  return {
    kind: "other",
    message: `The dashboard failed to start: ${readErrorMessage(error)}`,
  };
}
