import { type ButtonHTMLAttributes, type ReactNode, useState } from "react";

export function Card({
  children,
  className = "",
  flush = false,
}: {
  children: ReactNode;
  className?: string;
  /** Drop the padding, for cards whose rows or tables run to the card's edges. */
  flush?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border border-border bg-surface ${flush ? "" : "p-5"} ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * The page title row every tab opens with: the view's name as the one h1, an optional grey line
 * about the data under it, and the view's real actions on the right.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.01em] text-fg">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A card's title line: a 16px title, optional grey meta, and an optional trailing action. */
export function CardHeader({
  title,
  meta,
  action,
}: {
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        {meta ? <span className="num text-sm text-faint">{meta}</span> : null}
      </div>
      {action ? <div className="flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

/** A small status chip: pale tint with dark text of the same hue, or neutral grey. */
export function Pill({
  tone = "neutral",
  children,
  title,
}: {
  tone?: "neutral" | "accent" | "positive" | "warning" | "negative";
  children: ReactNode;
  title?: string;
}) {
  const tones = {
    neutral: "bg-subtle text-muted",
    accent: "bg-accent-soft text-accent-ink",
    positive: "bg-pill-positive-bg text-pill-positive-ink",
    warning: "bg-pill-warning-bg text-pill-warning-ink",
    negative: "bg-pill-negative-bg text-pill-negative-ink",
  } as const;
  return (
    <span
      title={title}
      className={`inline-flex h-5 flex-none items-center whitespace-nowrap rounded px-1.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = "primary",
  pressed,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "toggle";
  /** For `variant="toggle"`: whether the toggle is currently active. Sets `aria-pressed`. */
  pressed?: boolean;
}) {
  const base =
    "inline-flex h-9 flex-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3.5 text-sm font-medium transition-[background-color,color,border-color,transform] duration-150 active:translate-y-px focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0";
  const styles =
    variant === "primary"
      ? "bg-primary text-on-primary hover:bg-primary-hover"
      : variant === "secondary"
        ? "border border-control bg-surface text-fg hover:border-faint hover:bg-raised"
        : variant === "toggle"
          ? pressed
            ? "border border-accent/60 bg-accent-soft text-accent-ink"
            : "border border-control bg-surface text-muted hover:border-faint hover:text-fg"
          : "px-2.5 text-muted hover:bg-subtle hover:text-fg";
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
    <div aria-hidden="true" className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-subtle">
      <div
        data-testid="progress-fill"
        className="h-full rounded-full bg-accent transition-[width] duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Score thresholds shared by the ScorePill tone and the Matches default floor, so the "relevant"
 *  bar and the badge colors stay in sync if the scoring scale ever changes. */
export const SCORE_THRESHOLDS = { strong: 80, relevant: 50 } as const;

/**
 * The match score — the screen's main data element, so it carries the one accent hue: the figure in
 * ink inside a ring filled to its true share of 100. Strong matches draw the ring in the accent,
 * relevant ones in a lighter step of it, weak ones in grey.
 */
export function ScorePill({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  const radius = 17;
  const circumference = 2 * Math.PI * radius;
  const stroke =
    score >= SCORE_THRESHOLDS.strong
      ? "stroke-accent"
      : score >= SCORE_THRESHOLDS.relevant
        ? "stroke-accent/55"
        : "stroke-faint/50";
  return (
    <span className="relative inline-flex h-11 w-11 flex-none items-center justify-center">
      <svg aria-hidden="true" viewBox="0 0 40 40" className="absolute inset-0 -rotate-90">
        <circle cx="20" cy="20" r={radius} fill="none" strokeWidth="3" className="stroke-subtle" />
        <circle
          cx="20"
          cy="20"
          r={radius}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`}
          className={stroke}
        />
      </svg>
      <span
        className={`num relative text-sm font-semibold ${score >= SCORE_THRESHOLDS.relevant ? "text-fg" : "text-muted"}`}
      >
        <span className="sr-only">match score </span>
        {score}
      </span>
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
 * Inline "work in progress" indicator: a pulsing accent dot plus the live message in ink, so a
 * running scan/score reads as alive. Trailing `meta` (elapsed time, counts) stays quiet in the
 * faint token — the message is loud, its metadata is not.
 */
export function LiveStatus({ message, meta }: { message: string; meta?: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm font-medium text-fg">
      <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />
      <span>
        {message}
        {meta ? <span className="num ml-1 font-normal text-faint">{meta}</span> : null}
      </span>
    </p>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p
      aria-live="assertive"
      className="rounded-md bg-pill-negative-bg px-3 py-2 text-sm text-pill-negative-ink"
    >
      Something went wrong: {message}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-control px-4 py-6 text-center text-sm text-muted">
      {children}
    </p>
  );
}

/**
 * A destructive action that needs a second click: the first click arms it, the confirm button
 * performs it, and the cancel button backs out without side effects.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  pending = false,
}: {
  label: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  pending?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        {label}
      </Button>
    );
  }
  return (
    <>
      <Button variant="ghost" className="text-danger" disabled={pending} onClick={onConfirm}>
        {confirmLabel}
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)}>
        {cancelLabel}
      </Button>
    </>
  );
}
