/** The message of an `Error`, or a string coercion of any other thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
