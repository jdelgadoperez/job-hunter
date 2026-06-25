import { AshbyConnector } from "./ashby";
import { GreenhouseConnector } from "./greenhouse";
import { LeverConnector } from "./lever";
import { RecruiteeConnector } from "./recruitee";
import { RipplingConnector } from "./rippling";
import { SmartRecruitersConnector } from "./smartrecruiters";
import type { AtsConnector } from "./types";
import { WorkdayConnector } from "./workday";

// Connectors are stateless, so a single shared instance each is enough — used by both URL
// resolution (resolve-ats, by host) and liveness re-checks (fetch-liveness, by source), which
// previously kept separate registries that had to be updated in lockstep.
export const greenhouseConnector = new GreenhouseConnector();
export const leverConnector = new LeverConnector();
export const ashbyConnector = new AshbyConnector();
export const workdayConnector = new WorkdayConnector();
export const ripplingConnector = new RipplingConnector();
export const recruiteeConnector = new RecruiteeConnector();
export const smartRecruitersConnector = new SmartRecruitersConnector();

/**
 * ATS connectors keyed by their `source`, for liveness re-checks that re-fetch a board feed.
 * Workday is intentionally absent: it takes a full careers URL (not a re-derivable board token),
 * so its postings fall to the generic HTTP liveness re-check of the job URL instead. Every other
 * connector's board token is re-derivable (it's stamped as each posting's `company`), so a re-check
 * can re-fetch the board.
 */
export const connectorBySource: Record<string, AtsConnector> = Object.fromEntries(
  [
    greenhouseConnector,
    leverConnector,
    ashbyConnector,
    ripplingConnector,
    recruiteeConnector,
    smartRecruitersConnector,
  ].map((connector) => [connector.source, connector]),
);
