import type { LiveStatus } from "@app/domain/types";
import expiredMarkers from "./data/expired-markers.json";

export type LivenessSignal =
  | { kind: "ats-feed"; postingPresent: boolean }
  | { kind: "http"; statusCode: number; finalUrl: string; originalUrl: string; bodyText: string };

// Lower-cased substrings that indicate a posting has been taken down. Externalized to
// expired-markers.json, where each marker is annotated with the captured expired-page
// fixture it was confirmed against (see detect-liveness.test.ts).
const EXPIRED_MARKERS = expiredMarkers.markers.map((entry) => entry.marker);

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
