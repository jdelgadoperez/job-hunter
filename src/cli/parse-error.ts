/**
 * Node's `parseArgs` error message is two sentences: the first names the offending flag (e.g.
 * `Unknown option '--bogus-flag'.`), the second is a "place it at the end after --" escape-hatch
 * hint that's irrelevant to (and confusing for) the common case of a simple typo'd flag. Keep only
 * the first sentence so the error stays a single short clause, consistent with the CLI's other
 * hand-written errors (`invalid --port: ${value}`, `unknown command: ${command}`).
 */
export function describeParseError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const [firstSentence] = err.message.split(". ");
  return firstSentence ?? err.message;
}
