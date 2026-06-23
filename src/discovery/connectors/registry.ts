import { AshbyConnector } from "./ashby";
import { GreenhouseConnector } from "./greenhouse";
import { LeverConnector } from "./lever";
import type { AtsConnector } from "./types";

// Connectors are stateless, so a single shared instance each is enough — used by both URL
// resolution (resolve-ats, by host) and liveness re-checks (fetch-liveness, by source), which
// previously kept separate registries that had to be updated in lockstep.
export const greenhouseConnector = new GreenhouseConnector();
export const leverConnector = new LeverConnector();
export const ashbyConnector = new AshbyConnector();

/** ATS connectors keyed by their `source` (the value stamped onto every posting they produce). */
export const connectorBySource: Record<string, AtsConnector> = Object.fromEntries(
  [greenhouseConnector, leverConnector, ashbyConnector].map((connector) => [
    connector.source,
    connector,
  ]),
);
