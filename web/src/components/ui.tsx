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

export function ScorePill({ score }: { score: number }) {
  const tone = score >= 80 ? "text-success" : score >= 50 ? "text-warning" : "text-faint";
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
