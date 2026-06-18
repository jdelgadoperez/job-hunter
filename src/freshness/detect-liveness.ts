import type { LiveStatus } from "../domain/types.js";

export type LivenessSignal =
  | { kind: "ats-feed"; postingPresent: boolean }
  | { kind: "http"; statusCode: number; finalUrl: string; originalUrl: string; bodyText: string };

const EXPIRED_MARKERS = [
  "no longer accepting applications",
  "this position has been filled",
  "position is no longer available",
  "job posting not found",
  "this job is no longer available",
];

export function detectLiveness(signal: LivenessSignal): LiveStatus {
  if (signal.kind === "ats-feed") {
    return signal.postingPresent ? "live" : "expired";
  }

  if (signal.statusCode === 404 || signal.statusCode === 410) {
    return "expired";
  }

  const body = signal.bodyText.toLowerCase();
  if (EXPIRED_MARKERS.some((marker) => body.includes(marker))) {
    return "expired";
  }

  if (signal.statusCode >= 200 && signal.statusCode < 300) {
    return "live";
  }

  return "unknown";
}
