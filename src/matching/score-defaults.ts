/**
 * Default options for the deep-score pipeline, shared by the CLI `score` command (via `parse.ts`)
 * and the server's score-runner so the two entry points can't drift.
 */

/** Heuristic-score floor for gating which postings are eligible for deep-scoring. */
export const DEFAULT_MIN_HEURISTIC = 30;

/** Cap on how many postings a single deep-score run will LLM-score. */
export const DEFAULT_SCORE_LIMIT = 100;
