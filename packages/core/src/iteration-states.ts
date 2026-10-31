import type { IterationState, IterationStepState } from "./types.ts";

// debouncing → triaging ─┬→ skipped                    nothing to change
//                        ├→ awaiting_start → queued    manual mode or loop cap; you click Iterate
//                        ├→ held → queued              another iteration occupies the PR
//                        └→ queued
// queued → preparing → running → committing ─┬→ no_changes
//                                             ├→ replying → no_changes       no commit, but threads to answer
//                                             ├→ ready ─┬→ pushing (Push)
//                                             │         ├→ discarded (Discard)
//                                             │         └→ uncommitted (Uncommit; local checkout only)
//                                             └→ pushing → replying → pushed
// any → failed | stale | cancelled
//
// A retry parks the iteration back in `queued` (or `debouncing`, for triage) with
// `retryStep` set, like reviews.

const TERMINAL: ReadonlySet<IterationState> = new Set(["skipped", "no_changes", "pushed", "discarded", "uncommitted", "failed", "stale", "cancelled"]);
const IN_FLIGHT: ReadonlySet<IterationState> = new Set(["preparing", "running", "committing", "pushing", "replying"]);
/** At most one iteration per PR is in one of these; batches triaged meanwhile wait in `held`. */
const OCCUPYING: ReadonlySet<IterationState> = new Set(["queued", "preparing", "running", "committing", "ready", "pushing", "replying"]);
/** Steps that use the checkout and the agent, so they take a parallel-run slot. */
const AGENT_STEPS: ReadonlySet<IterationStepState> = new Set(["preparing", "running", "committing"]);

const FORWARD: Record<IterationState, readonly IterationState[]> = {
  debouncing: ["triaging"],
  triaging: ["skipped", "awaiting_start", "held", "queued", "debouncing"],
  awaiting_start: ["queued", "held"],
  held: ["queued"],
  queued: ["preparing", "committing", "pushing", "replying"],
  preparing: ["running", "queued"],
  // Back to preparing: an interrupted run starts over from a clean checkout.
  running: ["committing", "preparing", "queued"],
  committing: ["no_changes", "replying", "ready", "pushing", "queued"],
  ready: ["pushing", "discarded", "uncommitted"],
  pushing: ["replying", "queued"],
  replying: ["pushed", "no_changes", "queued"],
  skipped: [],
  no_changes: [],
  pushed: [],
  discarded: [],
  uncommitted: [],
  failed: [],
  stale: [],
  cancelled: [],
};

export function isIterationTerminal(state: IterationState): boolean {
  return TERMINAL.has(state);
}

export function isIterationInFlight(state: IterationState): state is IterationStepState {
  return IN_FLIGHT.has(state);
}

export function isIterationActive(state: IterationState): boolean {
  return !TERMINAL.has(state);
}

export function occupiesPr(state: IterationState): boolean {
  return OCCUPYING.has(state);
}

/** Whether running from this step on needs a parallel-run slot (pushing and replying don't). */
export function needsSlot(step: IterationStepState): boolean {
  return AGENT_STEPS.has(step);
}

export function canIterationTransition(from: IterationState, to: IterationState): boolean {
  if (TERMINAL.has(from)) return false;
  if (to === "failed" || to === "stale" || to === "cancelled") return true;
  return FORWARD[from].includes(to);
}

export const ITERATION_STATE_LABELS: Record<IterationState, string> = {
  debouncing: "Waiting for more comments",
  triaging: "Triaging comments",
  skipped: "Nothing to change",
  awaiting_start: "Waiting for Iterate",
  held: "Waiting for the current iteration",
  queued: "Queued",
  preparing: "Preparing checkout",
  running: "Addressing feedback",
  committing: "Committing",
  ready: "Ready to push",
  pushing: "Pushing",
  replying: "Replying on threads",
  pushed: "Pushed",
  no_changes: "No changes",
  discarded: "Discarded",
  uncommitted: "Uncommitted",
  failed: "Failed",
  stale: "Stale (the PR moved)",
  cancelled: "Cancelled",
};
