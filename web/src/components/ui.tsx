import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-border bg-surface p-4 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  pressed,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "toggle";
  /** For `variant="toggle"`: whether the toggle is currently active. Sets `aria-pressed`. */
  pressed?: boolean;
}) {
  const base =
    "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50";
  const styles =
    variant === "primary"
      ? "bg-primary text-on-primary hover:bg-primary-hover"
      : variant === "toggle"
        ? pressed
          ? "bg-primary text-on-primary hover:bg-primary-hover"
          : "border border-border text-muted hover:bg-subtle hover:text-fg"
        : "text-muted hover:bg-subtle hover:text-fg";
  const ariaPressed = variant === "toggle" ? pressed : undefined;
  return (
    <button
      type="button"
      aria-pressed={ariaPressed}
      className={`${base} ${styles} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * Decorative progress bar shared by the scan and deep-score panels. Purely visual — the live
 * text/status conveys progress to assistive tech, so the bar is aria-hidden. The width is clamped to
 * 0–100% so a `current` that briefly exceeds `total` (or a zero `total`) can't overflow the track.
 */
export function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((100 * current) / total))) : 0;
  return (
    <div aria-hidden="true" className="mt-2 h-2 w-full overflow-hidden rounded bg-subtle">
      <div
        data-testid="progress-fill"
        className="h-full bg-primary transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Score thresholds shared by the ScorePill tone and the Matches default floor, so the "relevant"
 *  bar and the badge colors stay in sync if the scoring scale ever changes. */
export const SCORE_THRESHOLDS = { strong: 80, relevant: 50 } as const;

export function ScorePill({ score }: { score: number }) {
  const tone =
    score >= SCORE_THRESHOLDS.strong
      ? "text-success"
      : score >= SCORE_THRESHOLDS.relevant
        ? "text-warning"
        : "text-faint";
  return (
    <span className={`rounded-full bg-subtle px-2 py-0.5 text-xs font-semibold ${tone}`}>
      <span className="sr-only">match score </span>
      {score}
    </span>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p aria-live="polite" className="py-8 text-center text-sm text-faint">
      {label}
    </p>
  );
}

/**
 * Inline "work in progress" indicator: a pulsing indigo dot plus the live message in the app's
 * active (primary) color, so a running scan/score reads as alive rather than fading into the
 * surrounding body copy. Trailing `meta` (elapsed time, counts) stays quiet in the faint token to
 * keep the emphasis hierarchy — the message is loud, its metadata is not.
 */
export function LiveStatus({ message, meta }: { message: string; meta?: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm font-medium text-primary">
      <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />
      <span>
        {message}
        {meta ? <span className="ml-1 font-normal text-faint">{meta}</span> : null}
      </span>
    </p>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p
      aria-live="assertive"
      className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      Something went wrong: {message}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-faint">{children}</p>;
}
