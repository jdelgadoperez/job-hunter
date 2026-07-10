/** Minimum Node.js major version the CLI supports (mirrors package.json `engines.node`). */
export const NODE_VERSION_FLOOR = 22;

/**
 * Compare a Node.js version string (e.g. `process.versions.node`) against the supported floor.
 * Returns a friendly, actionable warning when the running major is below the floor, else `null`.
 * An unparseable input returns `null` — a guard should never crash or warn on garbage input.
 */
export function checkNodeVersion(
  versionString: string,
  floorMajor: number = NODE_VERSION_FLOOR,
): string | null {
  const major = Number.parseInt(versionString.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major)) return null;
  if (major >= floorMajor) return null;
  return `job-hunter needs Node ${floorMajor} or newer (you have ${versionString}). Some features may not work; please upgrade Node.`;
}
