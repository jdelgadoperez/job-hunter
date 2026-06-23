import { styleText } from "node:util";

/**
 * Terminal styling for CLI output.
 *
 * The hard constraint: output must stay legible on a *default* light OR dark terminal. So we only
 * ever set a foreground from the terminal's own 16-color palette (which each theme maps to a
 * readable shade) plus `bold`/`dim` — never a background fill, never a hardcoded white/black. The
 * terminal's theme, not us, decides the actual color.
 */

type Format = Parameters<typeof styleText>[0];

/**
 * Whether to emit color, decided once from the environment. Disabled when stdout isn't a TTY (so
 * piped/redirected output and test captures stay plain), when `NO_COLOR` is set (https://no-color.org),
 * or for a `dumb` terminal.
 */
export function shouldColor(env: NodeJS.ProcessEnv, isTTY: boolean | undefined): boolean {
  if (env.NO_COLOR || env.TERM === "dumb") return false;
  // FORCE_COLOR lets users keep color through a pipe (e.g. `| less -R`), or "0" force-disable it;
  // otherwise color tracks whether stdout is an interactive terminal.
  if (env.FORCE_COLOR === "0") return false;
  if (env.FORCE_COLOR !== undefined) return true;
  return isTTY === true;
}

/** Apply `format` only when `on`; otherwise return the text untouched. Pure, so it's easy to test. */
export function colorize(format: Format, text: string, on: boolean): string {
  return on ? styleText(format, text) : text;
}

const ON = shouldColor(process.env, process.stdout.isTTY);

const paint = (format: Format) => (text: string) => colorize(format, text, ON);

export const style = {
  bold: paint("bold"),
  dim: paint("dim"),
  success: paint("green"),
  warn: paint("yellow"),
  error: paint("red"),
  url: paint("dim"),
};

/** A score badge colored by tier: strong matches green, mid yellow, weak dimmed. */
export function scoreBadge(score: number): string {
  const tier: Format = score >= 80 ? ["bold", "green"] : score >= 50 ? "yellow" : "dim";
  return colorize(tier, `[${score}]`, ON);
}
